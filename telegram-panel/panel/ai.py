"""The AI reply worker (PLAN.md §4.3).

A fan message on an AI-enabled account wakes this engine. It debounces a burst into one call,
builds the chatHistory from what's actually stored, asks Capitalbot once (`capital.py`), maps every
response flag to the chat's `ai_state`, and — only if the chat hasn't been answered meanwhile —
sends each content piece in order with a typing delay, converting voice notes with ffmpeg.

Reply-safety rules it must never break (CLAUDE.md): one Capitalbot call per chat at a time, at most
`MAX_IN_FLIGHT` across the panel, never a second send after a timeout/5xx, and never a reply to a
chat that was answered since the triggering fan message.
"""

import asyncio
import json
import logging
import shutil
import tempfile
from datetime import datetime, timedelta, timezone
from pathlib import Path

import httpx
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from panel.capital import KIND_MARKERS, UPLOADABLE_KINDS, CapitalClient, CapitalError, CapitalResponse
from panel.crypto import Crypto
from panel.db import get_setting
from panel.models import Account, Chat, Message, Profile, utcnow

log = logging.getLogger("panel.ai")

MAX_IN_FLIGHT = 10  # Capitalbot calls across the whole panel (PLAN.md §4.3 step 7)
HISTORY_MESSAGES = 50
HISTORY_MAX_BYTES = 200_000
TYPING_CAP_SEC = 6.0
DEFAULT_DEBOUNCE_SEC = 8
DEFAULT_TYPING_CPS = 20
CREDIT_OVER_PAUSE = timedelta(minutes=10)
MEDIA_PER_MIN = 5
MEDIA_PER_DAY = 30
KEEP_CALLING = ("active", "converted")
FILTER_FLAGS = ("tierFiltered", "genderFiltered", "ignored", "messagedAlready", "internalAccount")


def build_chat_history(msgs: list[Message], *, max_messages: int = HISTORY_MESSAGES, max_bytes: int = HISTORY_MAX_BYTES) -> list[dict]:
    """The last messages as Capitalbot's chatHistory. `out` → bot, fan → user; media becomes a
    marker; every entry carries an integer Unix-second timestamp (a missing one is a 400).

    The model's own turns are role `"bot"`, not `"assistant"` — that is the format Capitalbot's engine
    and Playground use (CapitalAI_Docs.md §"Follow-up Generation", lines 635/645/699). `"assistant"`
    appears only in the `/api/conversation` read transcript and makes `/generateResponse` 500."""
    items: list[dict] = []
    for m in msgs[-max_messages:]:
        if m.kind == "text" or m.kind == "other":
            content = (m.text or "").strip()
        else:
            content = KIND_MARKERS.get(m.kind) or (m.text or "").strip()
        if not content:
            continue
        items.append({"role": "bot" if m.direction == "out" else "user", "content": content, "timestamp": int(m.at.timestamp())})
    # Trim from the front until the JSON fits, but always keep at least the latest entry.
    while len(items) > 1 and len(json.dumps(items, ensure_ascii=False).encode()) > max_bytes:
        items.pop(0)
    return items


def merged_overrides(profile: Profile, account: Account) -> dict:
    """Profile persona overrides, with the account's own overrides layered on top (PLAN.md §3)."""
    out = dict(profile.overrides or {})
    out.update(account.profile_overrides or {})
    return out


class AiEngine:
    def __init__(
        self,
        sessionmaker: async_sessionmaker[AsyncSession],
        manager,
        capital: CapitalClient,
        crypto: Crypto,
        data_dir: Path,
        http: httpx.AsyncClient,
    ):
        self.sessionmaker = sessionmaker
        self.manager = manager
        self.capital = capital
        self.crypto = crypto
        self.media_dir = data_dir / "ai_media"
        self.media_dir.mkdir(parents=True, exist_ok=True)
        self._http = http
        self._sem = asyncio.Semaphore(MAX_IN_FLIGHT)
        self._debounce: dict[tuple[int, str], asyncio.Task] = {}
        self._chat_locks: dict[tuple[int, str], asyncio.Lock] = {}
        self.credit_over_until: datetime | None = None
        self.last_error: str | None = None
        # set by main.lifespan to Service.report_ai_outcome; reports the chat's convo state (and a
        # tierFiltered verdict that sends no reply) to the portal after each turn.
        self.report_ai_outcome = None  # type: ignore[assignment]

    # ── scheduling ────────────────────────────────────────────────────────────
    def notify(self, account_id: int, peer_id: str) -> None:
        """Called for every inbound fan message. Resets this chat's debounce timer."""
        key = (account_id, peer_id)
        old = self._debounce.get(key)
        if old is not None and not old.done():
            old.cancel()
        self._debounce[key] = asyncio.create_task(self._debounced(key, account_id, peer_id))

    async def _debounced(self, key: tuple[int, str], account_id: int, peer_id: str) -> None:
        try:
            await asyncio.sleep(await self._debounce_seconds())
        except asyncio.CancelledError:
            return
        self._debounce.pop(key, None)
        try:
            await self.run_turn(account_id, peer_id)
        except Exception:
            log.exception("AI turn failed for account=%s peer=%s", account_id, peer_id)

    async def _debounce_seconds(self) -> float:
        async with self.sessionmaker() as s:
            return float(await get_setting(s, "ai_debounce_sec", DEFAULT_DEBOUNCE_SEC))

    async def shutdown(self) -> None:
        for task in list(self._debounce.values()):
            task.cancel()

    # ── one turn for one chat ──────────────────────────────────────────────────
    async def run_turn(self, account_id: int, peer_id: str) -> None:
        lock = self._chat_locks.setdefault((account_id, peer_id), asyncio.Lock())
        async with lock:
            await self._run_turn(account_id, peer_id)

    async def _run_turn(self, account_id: int, peer_id: str) -> None:
        if not self.capital.configured:
            return
        if self.credit_over_until and utcnow() < self.credit_over_until:
            return
        req = await self._gather(account_id, peer_id)
        if req is None:
            return

        file_path: str | None = None
        try:
            async with self._sem:
                # Download inside the semaphore: at most MAX_IN_FLIGHT fan files on disk at once.
                file_path = await self._maybe_download_fan_media(account_id, peer_id, req)
                resp = await self.capital.generate_response(
                    model_id=req["model_id"],
                    preset_id=req["preset_id"],
                    account_id=req["account_id"],
                    user_infos=req["user_infos"],
                    chat_history=req["history"],
                    overrides=None,  # persona overrides crash Capitalbot — model + preset only (client decision 2026-10-17)
                    file_path=file_path,
                )
        except CapitalError as e:
            await self._on_error(account_id, peer_id, e)
            return
        finally:
            if file_path:
                Path(file_path).unlink(missing_ok=True)

        self.last_error = None
        answered = await self._apply(account_id, peer_id, resp, uploaded=bool(file_path), out_before=req["out_before"])
        if resp.has_content and not answered and self.manager.is_connected(account_id):
            await self._send(account_id, peer_id, resp)
        # Report the convo outcome to the portal — crucially, a tierFiltered verdict sends no reply,
        # so this is the only path that reports it (→ rejected non_tier1 instead of stuck Pending).
        if self.report_ai_outcome is not None:
            await self.report_ai_outcome(account_id, peer_id)

    async def _gather(self, account_id: int, peer_id: str) -> dict | None:
        """Re-check eligibility against fresh state and assemble the request inputs."""
        async with self.sessionmaker() as s:
            acc = await s.get(Account, account_id)
            if acc is None or not acc.power_on or not acc.ai_on or acc.profile_id is None:
                return None
            if not await get_setting(s, "ai_global_on", True):
                return None
            if not self.manager.is_connected(account_id):
                return None  # can't send a reply while disconnected
            profile = await s.get(Profile, acc.profile_id)
            if profile is None:
                return None
            chat = await s.scalar(select(Chat).where(Chat.account_id == account_id, Chat.peer_id == peer_id))
            if chat is None or chat.ai_state not in KEEP_CALLING:
                return None
            if chat.cooldown_until is not None and utcnow() < chat.cooldown_until:
                return None
            rows = (
                await s.scalars(
                    select(Message)
                    .where(Message.account_id == account_id, Message.peer_id == peer_id)
                    .order_by(Message.at.desc())
                    .limit(HISTORY_MESSAGES)
                )
            ).all()
            msgs = list(reversed(rows))
            history = build_chat_history(msgs)
            if not history:
                return None
            user_infos = {"useridentifier": peer_id}
            if chat.peer_name:
                user_infos["name"] = chat.peer_name
            if chat.peer_username:
                user_infos["username"] = chat.peer_username
            return {
                "model_id": profile.capital_model_id,
                "preset_id": profile.capital_preset_id,
                "account_id": str(acc.tg_user_id),
                "user_infos": user_infos,
                "history": history,
                "overrides": merged_overrides(profile, acc),
                "out_before": chat.last_out_at,
                "media": self._pick_fan_media(msgs, chat.last_out_at),
                "media_counter": dict(chat.media_uploads or {}),
            }

    def _pick_fan_media(self, msgs: list[Message], out_before: datetime | None) -> Message | None:
        """The newest uploadable fan media since the last reply (PLAN.md §4.3 step 6)."""
        for m in reversed(msgs):
            if m.direction == "in" and m.kind in UPLOADABLE_KINDS and (out_before is None or m.at > out_before):
                return m
        return None

    async def _maybe_download_fan_media(self, account_id: int, peer_id: str, req: dict) -> str | None:
        media: Message | None = req["media"]
        if media is None or not self._media_allowed(req["media_counter"]):
            return None
        client = self.manager.get(account_id)
        if client is None:
            return None
        try:
            got = await client.download_message_media(int(peer_id), media.tg_msg_id, self.media_dir)
        except Exception:
            log.exception("fan media download failed account=%s peer=%s", account_id, peer_id)
            return None
        return str(got) if got else None

    def _media_allowed(self, counter: dict) -> bool:
        now = utcnow()
        day, minute = now.strftime("%Y-%m-%d"), int(now.timestamp() // 60)
        day_count = counter.get("day_count", 0) if counter.get("day") == day else 0
        min_count = counter.get("min_count", 0) if counter.get("min") == minute else 0
        return day_count < MEDIA_PER_DAY and min_count < MEDIA_PER_MIN

    def _bump_media(self, counter: dict) -> dict:
        now = utcnow()
        day, minute = now.strftime("%Y-%m-%d"), int(now.timestamp() // 60)
        day_count = counter.get("day_count", 0) + 1 if counter.get("day") == day else 1
        min_count = counter.get("min_count", 0) + 1 if counter.get("min") == minute else 1
        return {"day": day, "day_count": day_count, "min": minute, "min_count": min_count}

    # ── response → state ────────────────────────────────────────────────────────
    async def _apply(self, account_id: int, peer_id: str, resp: CapitalResponse, *, uploaded: bool, out_before: datetime | None) -> bool:
        """Persist flag-driven state. Returns True if the chat was answered during the call (drop)."""
        async with self.sessionmaker() as s:
            chat = await s.scalar(select(Chat).where(Chat.account_id == account_id, Chat.peer_id == peer_id))
            if chat is None:
                return True
            if uploaded:
                chat.media_uploads = self._bump_media(dict(chat.media_uploads or {}))
            if resp.conversation_id and chat.capital_conversation_id is None:
                chat.capital_conversation_id = resp.conversation_id
            if resp.flag("chatCooldown") and resp.cooldown_until:
                chat.cooldown_until = datetime.fromtimestamp(resp.cooldown_until, tz=timezone.utc)

            note = self._set_state(chat, resp)
            if note:
                await self._log(s, "info" if note[0] else "warn", "ai_flag", f"@{peer_id}: {note[1]}", account_id)
            if resp.flag("aiCreditOver"):
                self.credit_over_until = utcnow() + CREDIT_OVER_PAUSE
                await self._log(s, "error", "ai_credit_over", "Capitalbot AI credits are depleted; pausing AI for 10 min", account_id)
            if not resp.has_content and resp.stop_flag is None and not resp.flag("chatCooldown"):
                # Empty content with no flag is a Capitalbot bug (docs): log it with the body.
                await self._log(s, "error", "ai_empty", f"empty content, no flag; convId={resp.conversation_id} body={json.dumps(resp.raw)[:400]}", account_id)

            answered = chat.last_out_at is not None and (out_before is None or chat.last_out_at > out_before)
            if resp.has_content and answered:
                await self._log(s, "info", "ai_dropped", f"@{peer_id}: reply dropped, chat already answered", account_id)
            await s.commit()
            return answered

    def _set_state(self, chat: Chat, resp: CapitalResponse) -> tuple[bool, str] | None:
        """Map the response to ai_state. Returns (ok, message) to log, or None for a plain reply."""
        was = chat.ai_state
        if resp.flag("underage"):
            chat.ai_state, chat.ai_state_reason = "stopped", "underage"
            return (False, "underage detected — stopped permanently")
        if resp.flag("timewaste"):
            chat.ai_state, chat.ai_state_reason = "stopped", "timewaste"
            return (False, "conversation ended (timewaste) — stopped")
        if resp.flag("ppvExhausted"):
            chat.ai_state, chat.ai_state_reason = "stopped", "ppvExhausted"
            return (False, "all PPV sold (ppvExhausted) — stopped")
        for flag in FILTER_FLAGS:
            if resp.flag(flag):
                chat.ai_state, chat.ai_state_reason = "filtered", flag
                return (False, f"filtered ({flag}) — stopped")
        if resp.flag("converted"):
            chat.ai_state, chat.ai_state_reason = "converted", None
            return (True, "converted") if was != "converted" else None
        if was == "converted":  # content came back with converted:false → un-converted
            chat.ai_state, chat.ai_state_reason = "active", None
            return (True, "un-converted — resuming")
        return None

    async def _on_error(self, account_id: int, peer_id: str, e: CapitalError) -> None:
        self.last_error = f"{e.kind}: {e.detail}"
        async with self.sessionmaker() as s:
            level = "error" if e.pause or e.kind in ("server", "bad_response") else "warn"
            await self._log(s, level, "ai_error", f"@{peer_id}: {e.detail}", account_id)
            if e.pause:
                acc = await s.get(Account, account_id)
                if acc is not None:
                    acc.ai_on = False  # a 400/401/403 is a config problem; stop calling until a human looks
            await s.commit()

    # ── sending ──────────────────────────────────────────────────────────────
    async def _send(self, account_id: int, peer_id: str, resp: CapitalResponse) -> None:
        client = self.manager.get(account_id)
        if client is None:
            return
        peer = int(peer_id)
        cps = await self._typing_cps()
        try:
            await client.mark_read(peer)
        except Exception:
            log.warning("mark_read failed account=%s peer=%s", account_id, peer_id)
        for item in resp.content:
            try:
                if item.type == "text":
                    await client.typing(peer, min(TYPING_CAP_SEC, max(0.5, len(item.content) / cps)))
                    mid = await client.send_text(peer, item.content)
                    kind, text = "text", item.content
                else:
                    mid = await self._send_media(client, peer, item)
                    if mid is None:
                        continue
                    kind, text = item.type, None
            except Exception:
                # Never resend a reply: stop this chat's sequence and let the next fan message retrigger.
                log.exception("send failed account=%s peer=%s; stopping sequence", account_id, peer_id)
                async with self.sessionmaker() as s:
                    await self._log(s, "warn", "ai_send_failed", f"@{peer_id}: a reply piece failed to send", account_id)
                    await s.commit()
                return
            await self.service_record(account_id, peer_id, mid, kind, text, utcnow())

    # set by main.lifespan to Service.record_ai_message (keeps ai.py free of a hard service import)
    service_record = None  # type: ignore[assignment]

    async def _send_media(self, client, peer: int, item) -> int | None:
        path, temp = await self._resolve_media(item.content)
        if path is None:
            async with self.sessionmaker() as s:
                await self._log(s, "warn", "ai_media_skip", f"couldn't fetch media {item.content[:120]}", None)
                await s.commit()
            return None
        try:
            if item.type == "audio":
                voice = await self._to_voice(path)
                if voice is not None:
                    try:
                        return await client.send_file(peer, str(voice), voice=True)
                    finally:
                        voice.unlink(missing_ok=True)
                return await client.send_file(peer, str(path))  # ffmpeg unavailable → plain audio file
            return await client.send_file(peer, str(path))
        finally:
            if temp:
                path.unlink(missing_ok=True)

    async def _resolve_media(self, url: str) -> tuple[Path | None, bool]:
        """A Capitalbot media URL → a local file. http(s) is downloaded (temp); a file:// or existing
        local path is used in place (so tests need no network)."""
        if url.startswith("http://") or url.startswith("https://"):
            try:
                r = await self._http.get(url, timeout=60)
                r.raise_for_status()
            except httpx.HTTPError:
                return None, False
            suffix = Path(url.split("?", 1)[0]).suffix or ".bin"
            fd, name = tempfile.mkstemp(dir=self.media_dir, suffix=suffix)
            path = Path(name)
            with open(fd, "wb") as fh:
                fh.write(r.content)
            return path, True
        local = Path(url[7:] if url.startswith("file://") else url)
        return (local, False) if local.is_file() else (None, False)

    async def _to_voice(self, src: Path) -> Path | None:
        """Convert to OGG/Opus for a Telegram voice note. None if ffmpeg is missing or fails."""
        if shutil.which("ffmpeg") is None:
            return None
        out = src.with_suffix(".voice.ogg")
        proc = await asyncio.create_subprocess_exec(
            "ffmpeg", "-y", "-i", str(src), "-c:a", "libopus", "-b:a", "48k", str(out),
            stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.DEVNULL,
        )
        await proc.wait()
        return out if proc.returncode == 0 and out.is_file() else None

    async def _typing_cps(self) -> float:
        async with self.sessionmaker() as s:
            return float(await get_setting(s, "typing_cps", DEFAULT_TYPING_CPS)) or DEFAULT_TYPING_CPS

    async def _log(self, s: AsyncSession, level: str, kind: str, message: str, account_id: int | None) -> None:
        from panel.models import Activity

        s.add(Activity(level=level, kind=kind, message=message[:1000], account_id=account_id))
