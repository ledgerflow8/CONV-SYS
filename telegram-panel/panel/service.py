"""The glue between the DB, the crypto and the AccountManager. Routes call this; it owns no
Telegram logic of its own (that's AccountManager / tg/) and no HTTP (that's routes/)."""

import asyncio
import logging
import random
from datetime import datetime
from pathlib import Path

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from panel import portal
from panel.accounts import AccountManager
from panel.crypto import Crypto
from panel.models import Account, Activity, Chat, Message, utcnow
from panel.tg.client import AccountInfo, ConnectParams, IncomingMessage, TgError

# Internal account status → the portal's account_status enum (PLAN.md §4.4).
# connecting is transient and never reported; error is reported as offline.
_PORTAL_STATUS = {"online": "online", "offline": "offline", "limited": "limited", "banned": "banned", "revoked": "revoked", "frozen": "frozen", "error": "offline"}

RECONNECTING_DETAIL = "Reconnecting to Telegram…"  # friendly card text; never the raw exception


def _later(a: datetime | None, b: datetime | None) -> datetime | None:
    if a is None:
        return b
    if b is None:
        return a
    return a if a >= b else b


def _ai_tier(chat: Chat) -> str | None:
    """Capitalbot's tier verdict for this chat, read from AI state we already store (no new column).
    'T1'     = Capitalbot engaged this fan normally (it has a conversation and didn't tier-filter);
    'NON_T1' = Capitalbot tier-filtered them;
    None     = no verdict, so the portal falls back to phone / click / review.
    The portal trusts this only when the fan's phone is hidden."""
    if chat.ai_state_reason == "tierFiltered":
        return "NON_T1"
    if chat.ai_state == "filtered":
        return None  # genderFiltered / ignored / messagedAlready / internalAccount — not a tier call
    if chat.capital_conversation_id is not None:
        return "T1"
    return None


log = logging.getLogger("panel.service")


class Service:
    def __init__(
        self,
        sessionmaker: async_sessionmaker[AsyncSession],
        crypto: Crypto,
        manager: AccountManager,
        data_dir: Path,
        default_api_id: int | None,
        default_api_hash: str | None,
    ):
        self.sessionmaker = sessionmaker
        self.crypto = crypto
        self.manager = manager
        self.avatar_dir = data_dir / "avatars"
        self.avatar_dir.mkdir(parents=True, exist_ok=True)
        self.default_api_id = default_api_id
        self.default_api_hash = default_api_hash
        self.import_gap_seconds = 2.0  # pause between test-connects so a batch isn't a login flood
        self.ai = None  # the AiEngine, wired in by main.lifespan (step 3). None in step-1/2 tests.
        # Auto-reconnect backoff for transient drops (network, timeout, unreadable update). Seconds;
        # holds at the last value, with jitter so 100 accounts don't reconnect in lockstep.
        self.reconnect_delays = [5.0, 15.0, 30.0, 60.0, 120.0, 300.0]
        self.reconnect_jitter = 0.2
        self._reconnect_tasks: dict[int, asyncio.Task] = {}

    # ── helpers ────────────────────────────────────────────────────────────
    def connect_params(self, acc: Account, session_string: str | None = None) -> ConnectParams:
        return ConnectParams(
            session=session_string if session_string is not None else self.crypto.decrypt(acc.session_enc),
            api_id=acc.api_id,
            api_hash=acc.api_hash,
            device_model=acc.device_model,
            system_version=acc.system_version,
            app_version=acc.app_version,
            lang_code=acc.lang_code,
            system_lang_code=acc.system_lang_code,
        )

    async def log_activity(self, session: AsyncSession, level: str, kind: str, message: str, account_id: int | None = None) -> None:
        session.add(Activity(level=level, kind=kind, message=message[:1000], account_id=account_id))

    def message_cb(self, account_id: int):
        """A per-account callback handed to the Telegram client; keeps the account id out of tg/."""

        async def cb(msg: IncomingMessage) -> None:
            try:
                await self.on_message(account_id, msg)
            except Exception:
                log.exception("on_message failed for account %s", account_id)

        return cb

    # ── incoming/outgoing messages → store + portal events (PLAN.md §4.3–§4.4) ──
    async def on_message(self, account_id: int, msg: IncomingMessage) -> None:
        async with self.sessionmaker() as session:
            acc = await session.get(Account, account_id)
            if acc is None:
                return
            await self._store_message(session, account_id, msg)
            chat = await self._get_or_create_chat(session, account_id, msg)

            # Timestamps on the chat and the account (this is what finally colours the cards).
            acc.last_msg_at = _later(acc.last_msg_at, msg.at)
            if msg.out:
                chat.last_out_at = _later(chat.last_out_at, msg.at)
            else:
                chat.last_in_at = _later(chat.last_in_at, msg.at)
                acc.last_incoming_at = _later(acc.last_incoming_at, msg.at)

            # Peer details fill in as we learn them.
            chat.peer_username = chat.peer_username or msg.peer.username
            chat.peer_name = chat.peer_name or msg.peer.name
            chat.peer_phone = chat.peer_phone or msg.peer.phone

            # First inbound sets the real conversation start (read from Telegram history once).
            if chat.first_in_at is None and not msg.out:
                first_in, first_reply = await self._dialog_firsts(account_id, msg.peer.peer_id, fallback=msg.at)
                chat.first_in_at = first_in
                if first_reply is not None and chat.first_reply_at is None:
                    chat.first_reply_at = first_reply

            # First reply at or after the first inbound (AI or typed by hand).
            if msg.out and chat.first_in_at is None:
                # We saw our reply before any inbound event (e.g. connected mid-chat). Backfill the
                # real start from history — but only if the fan actually messaged first, so a cold
                # outreach never becomes a convo. This keeps a replied convo from staying Pending.
                first_in, first_reply = await self._dialog_firsts_raw(account_id, msg.peer.peer_id)
                if first_in is not None:
                    chat.first_in_at = first_in
                    chat.first_reply_at = chat.first_reply_at or first_reply or msg.at
            elif msg.out and chat.first_in_at is not None and chat.first_reply_at is None and msg.at >= chat.first_in_at:
                chat.first_reply_at = msg.at

            await self._report_chat(session, acc, chat)
            # A fresh fan message on an AI-enabled account wakes the debounced AI worker (step 3).
            should_ai = (not msg.out) and acc.ai_on and acc.power_on and acc.profile_id is not None
            await session.commit()

        if should_ai and self.ai is not None:
            self.ai.notify(account_id, msg.peer.peer_id)

    async def record_ai_message(self, account_id: int, peer_id: str, tg_msg_id: int, kind: str, text: str | None, at: datetime) -> None:
        """Store an outgoing AI message after Telegram accepted it, and roll the chat/account forward
        the same way an inbound message would (so first-reply reporting fires). Idempotent, and it
        relabels a row the outgoing-message listener may have stored first as `manual`."""
        async with self.sessionmaker() as session:
            acc = await session.get(Account, account_id)
            if acc is None:
                return
            existing = await session.scalar(
                select(Message).where(
                    Message.account_id == account_id, Message.peer_id == peer_id, Message.tg_msg_id == tg_msg_id
                )
            )
            if existing is not None:
                existing.sender, existing.kind = "ai", kind  # the AI label wins over a raced `manual`
            else:
                session.add(
                    Message(account_id=account_id, peer_id=peer_id, tg_msg_id=tg_msg_id, direction="out", sender="ai", kind=kind, text=text, at=at)
                )
            chat = await session.scalar(select(Chat).where(Chat.account_id == account_id, Chat.peer_id == peer_id))
            if chat is not None:
                chat.last_out_at = _later(chat.last_out_at, at)
                if chat.first_in_at is not None and chat.first_reply_at is None and at >= chat.first_in_at:
                    chat.first_reply_at = at
                await self._report_chat(session, acc, chat)
            acc.last_msg_at = _later(acc.last_msg_at, at)
            await session.commit()

    async def _store_message(self, session: AsyncSession, account_id: int, msg: IncomingMessage) -> None:
        exists = await session.scalar(
            select(Message.id).where(
                Message.account_id == account_id, Message.peer_id == msg.peer.peer_id, Message.tg_msg_id == msg.tg_msg_id
            )
        )
        if exists is not None:  # already stored (e.g. the AI sender recorded its own reply first)
            return
        session.add(
            Message(
                account_id=account_id,
                peer_id=msg.peer.peer_id,
                tg_msg_id=msg.tg_msg_id,
                direction="out" if msg.out else "in",
                sender="manual" if msg.out else "fan",
                kind=msg.kind,
                text=msg.text,
                at=msg.at,
            )
        )

    async def _get_or_create_chat(self, session: AsyncSession, account_id: int, msg: IncomingMessage) -> Chat:
        chat = await session.scalar(
            select(Chat).where(Chat.account_id == account_id, Chat.peer_id == msg.peer.peer_id)
        )
        if chat is None:
            chat = Chat(account_id=account_id, peer_id=msg.peer.peer_id)
            session.add(chat)
            await session.flush()
        return chat

    async def _dialog_firsts_raw(self, account_id: int, peer_id: str) -> tuple[datetime | None, datetime | None]:
        """(first inbound, first reply) straight from Telegram history, or (None, None)."""
        client = self.manager.get(account_id)
        if client is not None:
            try:
                return await client.dialog_firsts(int(peer_id))
            except Exception:
                log.exception("dialog_firsts failed for account %s peer %s", account_id, peer_id)
        return None, None

    async def _dialog_firsts(self, account_id: int, peer_id: str, fallback: datetime) -> tuple[datetime, datetime | None]:
        first_in, first_reply = await self._dialog_firsts_raw(account_id, peer_id)
        return (first_in or fallback), first_reply

    async def _report_chat(self, session: AsyncSession, acc: Account, chat: Chat) -> None:
        """Enqueue the convo events this chat is now due. Reporting is independent of the AI toggle."""
        tg_account = acc.username or str(acc.tg_user_id)
        tg_user_id = str(acc.tg_user_id)
        if chat.first_in_at is not None and not chat.reported_first:
            await portal.enqueue_convo(session, tg_account, tg_user_id, chat, with_reply=False)
            chat.reported_first = True
        if chat.first_reply_at is not None and not chat.reported_reply:
            # A reply from Capitalbot carries its "Tier 1 (AI verified)" verdict, used when no phone.
            await portal.enqueue_convo(session, tg_account, tg_user_id, chat, with_reply=True, tier=_ai_tier(chat))
            chat.reported_reply = True

    async def report_ai_outcome(self, account_id: int, peer_id: str) -> None:
        """Called after an AI turn (wired from ai.py). Makes sure the portal has this chat's convo
        state, including a Capitalbot tier verdict that produced no reply (tierFiltered → non_tier1),
        which the first/reply events can't carry."""
        async with self.sessionmaker() as session:
            acc = await session.get(Account, account_id)
            if acc is None:
                return
            chat = await session.scalar(select(Chat).where(Chat.account_id == account_id, Chat.peer_id == peer_id))
            if chat is None:
                return
            await self._report_chat(session, acc, chat)  # first / reply (the reply event carries a T1 verdict)
            if chat.first_in_at is not None and _ai_tier(chat) == "NON_T1":
                # tierFiltered sends no reply, so the verdict rides its own event. Reported once: the
                # chat is now 'filtered' and won't be called again, so this runs a single time.
                await portal.enqueue_convo(
                    session, acc.username or str(acc.tg_user_id), str(acc.tg_user_id), chat, with_reply=False, tier="NON_T1", suffix="tier"
                )
            await session.commit()

    async def _enqueue_status(self, session: AsyncSession, acc: Account) -> None:
        portal_status = _PORTAL_STATUS.get(acc.status)
        if portal_status is None:
            return
        tg_account = acc.username or str(acc.tg_user_id)
        await portal.enqueue_account_status(session, tg_account, str(acc.tg_user_id), portal_status, utcnow(), acc.status_detail)

    async def _enqueue_register(self, session: AsyncSession, acc: Account) -> None:
        """Register/refresh this account in the portal's pool, keyed by Telegram id (arrives unassigned)."""
        link = f"https://t.me/{acc.username}" if acc.username else None
        await portal.enqueue_account_register(session, str(acc.tg_user_id), acc.username, acc.phone, link)

    async def _on_drop(self, account_id: int, err: TgError | None) -> None:
        """Called by AccountManager when a live connection drops on its own.

        Dead (banned/revoked) → park it and power off; it won't come back by reconnecting.
        Frozen → record it and leave it alone (its own state, not a fault to retry).
        Anything else (network, timeout, an update from a newer Telegram layer) is transient:
        keep power on, show "reconnecting" (never the raw exception) and reconnect with backoff.
        """
        reconnect = False
        retry_after: int | None = None
        async with self.sessionmaker() as session:
            acc = await session.get(Account, account_id)
            if not acc:
                return
            old = acc.status
            raw = err.raw if err else None
            status = err.status if err else "offline"
            detail = err.detail if err else None
            log.warning("connection dropped account=%s @%s status=%s raw=%s detail=%s", account_id, acc.username, status, raw, detail)
            if err and err.dead:
                acc.status, acc.status_detail = err.status, err.detail
                acc.power_on = False  # a dead session won't come back by reconnecting
                await self.log_activity(session, "error", "account_dropped", f"@{acc.username}: {err.detail} [{raw}]", account_id)
            elif err and err.status == "frozen":
                acc.status, acc.status_detail = "frozen", err.detail
                await self.log_activity(session, "warn", "account_dropped", f"@{acc.username}: {err.detail} [{raw}]", account_id)
            else:
                acc.status, acc.status_detail = "connecting", RECONNECTING_DETAIL
                await self.log_activity(session, "warn", "account_reconnecting", f"@{acc.username or acc.tg_user_id}: {detail or 'connection lost'} [{raw}] — reconnecting", account_id)
                reconnect = True
                retry_after = err.retry_after if err else None
            acc.updated_at = utcnow()
            if acc.status != old:
                await self._enqueue_status(session, acc)  # "connecting" isn't reported (transient)
            await session.commit()
        if reconnect:
            self._schedule_reconnect(account_id, first_delay=retry_after)

    def on_drop(self):
        return self._on_drop

    # ── auto-reconnect (resilience against newer-layer updates and network blips) ──
    def _reconnect_delay(self, attempt: int) -> float:
        base = self.reconnect_delays[min(attempt, len(self.reconnect_delays) - 1)]
        return base + base * self.reconnect_jitter * random.random() if self.reconnect_jitter else base

    def _schedule_reconnect(self, account_id: int, first_delay: float | None = None) -> None:
        task = self._reconnect_tasks.get(account_id)
        if task and not task.done():
            return  # a reconnect loop is already running for this account
        self._reconnect_tasks[account_id] = asyncio.create_task(self._reconnect_loop(account_id, first_delay))

    async def _reconnect_loop(self, account_id: int, first_delay: float | None = None) -> None:
        """Keep trying to bring a transiently-dropped account back, with backoff, until it's online
        again or it's powered off / removed / turns out dead or frozen."""
        attempt = 0
        try:
            while True:
                delay = first_delay if (attempt == 0 and first_delay) else self._reconnect_delay(attempt)
                await asyncio.sleep(delay)
                async with self.sessionmaker() as session:
                    acc = await session.get(Account, account_id)
                    if acc is None or not acc.power_on or acc.status in ("banned", "revoked", "frozen"):
                        return  # someone powered it off / deleted it, or it's terminal
                    params = self.connect_params(acc)
                if self.manager.is_connected(account_id):
                    return  # a manual power-on got there first
                try:
                    info = await self.manager.connect(account_id, params, self.on_drop(), self.message_cb(account_id))
                except TgError as e:
                    if e.leave_alone:  # dead or frozen: stop retrying
                        await self._mark_status(account_id, e.status, e.detail, power_off=e.dead)
                        return
                    attempt += 1
                    await self._mark_reconnecting(account_id, attempt)
                    continue
                except Exception:
                    log.exception("reconnect attempt failed for %s", account_id)
                    attempt += 1
                    await self._mark_reconnecting(account_id, attempt)
                    continue
                await self._mark_online(account_id, info)
                asyncio.create_task(self.refresh_avatar(account_id))
                async with self.sessionmaker() as session:
                    acc = await session.get(Account, account_id)
                    if acc:
                        await self.log_activity(session, "info", "account_reconnected", f"@{acc.username or acc.tg_user_id}: reconnected", account_id)
                        await session.commit()
                return
        except asyncio.CancelledError:
            pass
        finally:
            self._reconnect_tasks.pop(account_id, None)

    async def _mark_reconnecting(self, account_id: int, attempt: int) -> None:
        """Keep the card message clear while retries continue (#4: never the raw exception)."""
        detail = RECONNECTING_DETAIL if attempt < 3 else f"Can't reach Telegram — still retrying (attempt {attempt})."
        async with self.sessionmaker() as session:
            acc = await session.get(Account, account_id)
            if acc and acc.power_on and acc.status not in ("banned", "revoked", "frozen"):
                acc.status, acc.status_detail = "connecting", detail
                acc.updated_at = utcnow()
                await session.commit()

    async def cancel_reconnect(self, account_id: int) -> None:
        """Stop a pending reconnect loop (on power-off, delete, or a manual power-on taking over)."""
        task = self._reconnect_tasks.pop(account_id, None)
        if task and not task.done():
            task.cancel()
            try:
                await task
            except (asyncio.CancelledError, Exception):
                pass

    async def cancel_all_reconnects(self) -> None:
        for account_id in list(self._reconnect_tasks):
            await self.cancel_reconnect(account_id)

    # ── avatars ────────────────────────────────────────────────────────────
    async def refresh_avatar(self, account_id: int) -> None:
        client = self.manager.get(account_id)
        if not client:
            return
        path = self.avatar_dir / f"{account_id}.jpg"
        if await client.download_avatar(path):
            async with self.sessionmaker() as session:
                acc = await session.get(Account, account_id)
                if acc:
                    acc.avatar_path = str(path)
                    await session.commit()

    # ── lifecycle (step 5 adds the health loop; step 0/1 need startup connect) ──
    async def connect_powered_on(self) -> None:
        """On startup, connect accounts whose power is on. Staggered, so a batch doesn't look
        like a login flood from one IP."""
        async with self.sessionmaker() as session:
            rows = (await session.scalars(select(Account).where(Account.power_on.is_(True)))).all()
            # Reconnect everything powered on — including accounts parked offline/error by an earlier
            # drop (e.g. a newer-layer update) — but leave banned/revoked/frozen alone.
            targets = [(a.id, self.connect_params(a)) for a in rows if a.status not in ("banned", "revoked", "frozen")]
        for account_id, params in targets:
            try:
                info = await self.manager.connect(account_id, params, self.on_drop(), self.message_cb(account_id))
                await self._mark_online(account_id, info)
                asyncio.create_task(self.refresh_avatar(account_id))
            except TgError as e:
                log.warning("startup connect failed account=%s status=%s raw=%s detail=%s", account_id, e.status, e.raw, e.detail)
                async with self.sessionmaker() as session:
                    await self.log_activity(session, "error", "connect_failed", f"startup: {e.detail} [{e.raw}]", account_id)
                    await session.commit()
                if e.leave_alone:
                    await self._mark_status(account_id, e.status, e.detail, power_off=e.dead)
                else:
                    # Transient (network/timeout/unreadable update): keep trying in the background.
                    await self._mark_status(account_id, "connecting", RECONNECTING_DETAIL)
                    self._schedule_reconnect(account_id)
            except Exception:
                log.exception("startup connect failed for %s", account_id)
            await asyncio.sleep(1.0)

    async def _mark_online(self, account_id: int, info: AccountInfo) -> None:
        async with self.sessionmaker() as session:
            acc = await session.get(Account, account_id)
            if acc:
                old = acc.status
                acc.status, acc.status_detail = "online", None
                if info.username:
                    acc.username = info.username
                if info.phone:
                    acc.phone = info.phone
                acc.first_name = info.first_name
                acc.updated_at = utcnow()
                if acc.status != old:
                    await self._enqueue_status(session, acc)
                await self._enqueue_register(session, acc)  # keep the portal pool in sync with identity
                await session.commit()

    async def _mark_status(self, account_id: int, status: str, detail: str | None, power_off: bool = False) -> None:
        async with self.sessionmaker() as session:
            acc = await session.get(Account, account_id)
            if acc:
                old = acc.status
                acc.status, acc.status_detail = status, detail
                if power_off:
                    acc.power_on = False
                acc.updated_at = utcnow()
                if acc.status != old:
                    await self._enqueue_status(session, acc)
                await session.commit()
