import asyncio
import logging
import re
import tempfile
from pathlib import Path

from fastapi import APIRouter, Depends, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field
from sqlalchemy import func, or_, select

from panel import portal
from panel.auth import require_login
from panel.capital import ALLOWED_OVERRIDE_KEYS
from panel.db import get_setting
from panel.health import health_color
from panel.models import Account, Chat, Profile, utcnow
from panel.tg.client import PRIVACY_KEYS, PRIVACY_RULES, TgError

router = APIRouter(prefix="/api/accounts", dependencies=[Depends(require_login)])

log = logging.getLogger("panel.routes.accounts")

DEFAULT_QUIET_HOURS = 12
NAME_MAX = 64  # Telegram first/last name limit
BIO_MAX = 70  # Telegram "about" limit
USERNAME_RE = re.compile(r"[A-Za-z0-9_]{5,32}")  # 5–32 chars, a–z/0–9/_ (CheckUsername is authoritative)
PHOTO_TYPES = {"image/jpeg": ".jpg", "image/png": ".png"}
PHOTO_MAX_BYTES = 10 * 1024 * 1024


def _tg_http(e: TgError) -> HTTPException:
    """Map a Telegram failure to a clear panel HTTP error."""
    if e.status == "limited":
        mins = max(1, round((e.retry_after or 60) / 60))
        return HTTPException(429, f"Telegram is rate-limiting this account — try again in about {mins} min.")
    if e.status == "username_taken":
        return HTTPException(409, "That username is already taken.")
    if e.status == "username_invalid":
        return HTTPException(400, "That username isn't valid (5–32 characters, a–z, 0–9 and _).")
    return HTTPException(502, f"Telegram rejected the change: {e.detail}")


def _service(request: Request):
    return request.app.state.service


async def _quiet_hours(session) -> int:
    return int(await get_setting(session, "quiet_after_hours", DEFAULT_QUIET_HOURS))


def _avatar_version(acc: Account) -> int | None:
    """A cache-buster that changes only when the avatar file is rewritten.

    Appended as ?v=<version> so Safari (which caches the fixed avatar URL hard)
    shows a changed or removed photo immediately.
    """
    if not acc.avatar_path:
        return None
    try:
        return int(Path(acc.avatar_path).stat().st_mtime)
    except OSError:
        return None


def _card(acc: Account, quiet_hours: int, connected: bool, in_portal: bool | None = None) -> dict:
    return {
        "id": acc.id,
        "tg_user_id": str(acc.tg_user_id),
        "username": acc.username,
        "phone": acc.phone,
        "first_name": acc.first_name,
        "status": acc.status,
        "status_detail": acc.status_detail,
        "color": health_color(acc, quiet_hours),
        "power_on": acc.power_on,
        "connected": connected,
        "ai_on": acc.ai_on,
        "profile_id": acc.profile_id,
        "has_username": bool(acc.username),  # no username → can't be a tracking-link account in the portal
        "has_avatar": bool(acc.avatar_path),
        "avatar_version": _avatar_version(acc),
        "last_msg_at": acc.last_msg_at.isoformat() if acc.last_msg_at else None,
        "last_incoming_at": acc.last_incoming_at.isoformat() if acc.last_incoming_at else None,
    }


@router.get("")
async def list_accounts(request: Request, q: str | None = None) -> dict:
    service = _service(request)
    async with service.sessionmaker() as session:
        quiet = await _quiet_hours(session)
        stmt = select(Account)
        if q:
            like = f"%{q.strip().lower().lstrip('@')}%"
            stmt = stmt.where(or_(func.lower(Account.username).like(like), Account.phone.like(like)))
        stmt = stmt.order_by(Account.last_msg_at.desc().nullslast(), Account.id.desc())
        accounts = (await session.scalars(stmt)).all()
        cards = [_card(a, quiet, service.manager.is_connected(a.id)) for a in accounts]

    counts = {"all": len(cards), "green": 0, "amber": 0, "red": 0, "grey": 0, "purple": 0}
    for c in cards:
        counts[c["color"]] += 1
    return {"accounts": cards, "counts": counts}


@router.get("/{account_id}")
async def get_account(account_id: int, request: Request) -> dict:
    service = _service(request)
    async with service.sessionmaker() as session:
        acc = await session.get(Account, account_id)
        if not acc:
            raise HTTPException(404, "No such account")
        quiet = await _quiet_hours(session)
        card = _card(acc, quiet, service.manager.is_connected(acc.id))
        card["profile_overrides"] = acc.profile_overrides or {}
        card["capital_model_id"] = card["capital_preset_id"] = None
        if acc.profile_id is not None:
            prof = await session.get(Profile, acc.profile_id)
            card["profile_name"] = prof.name if prof else None
            if prof:
                card["capital_model_id"], card["capital_preset_id"] = prof.capital_model_id, prof.capital_preset_id
        else:
            card["profile_name"] = None
        chats = (
            await session.scalars(
                select(Chat)
                .where(Chat.account_id == account_id)
                .order_by(Chat.last_in_at.desc().nullslast(), Chat.id.desc())
                .limit(20)
            )
        ).all()
        card["chats"] = []
        for c in chats:
            cc = service.cached_country(account_id, c.peer_id)
            card["chats"].append(
                {
                    "peer_id": c.peer_id,
                    "peer_name": c.peer_name,
                    "peer_username": c.peer_username,
                    "ai_state": c.ai_state,
                    "ai_state_reason": c.ai_state_reason,
                    "cooldown_until": c.cooldown_until.isoformat() if c.cooldown_until else None,
                    "last_in_at": c.last_in_at.isoformat() if c.last_in_at else None,
                    "last_out_at": c.last_out_at.isoformat() if c.last_out_at else None,
                    "country": cc["country"] if cc else None,
                    "country_source": cc["source"] if cc else None,
                }
            )
    return card


class PatchBody(BaseModel):
    profile_id: int | None = None
    profile_overrides: dict | None = None


@router.patch("/{account_id}")
async def patch_account(account_id: int, body: PatchBody, request: Request) -> dict:
    service = _service(request)
    async with service.sessionmaker() as session:
        acc = await session.get(Account, account_id)
        if not acc:
            raise HTTPException(404, "No such account")
        fields = body.model_dump(exclude_unset=True)
        if "profile_id" in fields:
            if body.profile_id is not None and not await session.get(Profile, body.profile_id):
                raise HTTPException(404, "No such persona")
            acc.profile_id = body.profile_id
            if body.profile_id is None:
                acc.ai_on = False  # AI can't run without a persona
        if "profile_overrides" in fields:
            acc.profile_overrides = {k: v for k, v in (body.profile_overrides or {}).items() if k in ALLOWED_OVERRIDE_KEYS and v is not None}
        await session.commit()
    return {"ok": True}


class PresetBody(BaseModel):
    model_id: int
    preset_id: int
    name: str | None = None  # label for the auto-created profile (the preset's name)


@router.post("/{account_id}/preset")
async def set_preset(account_id: int, body: PresetBody, request: Request) -> dict:
    """Point the account at a Capitalbot model+preset and switch AI on. Reuses (or creates) a thin
    profile holding just those ids — no overrides are ever sent (client decision 2026-10-17)."""
    async with _service(request).sessionmaker() as session:
        acc = await session.get(Account, account_id)
        if not acc:
            raise HTTPException(404, "No such account")
        prof = await session.scalar(
            select(Profile).where(Profile.capital_model_id == body.model_id, Profile.capital_preset_id == body.preset_id).limit(1)
        )
        if prof is None:
            prof = Profile(name=(body.name or f"Preset {body.preset_id}")[:100], capital_model_id=body.model_id, capital_preset_id=body.preset_id, overrides={})
            session.add(prof)
            await session.flush()
        acc.profile_id = prof.id
        acc.profile_overrides = {}
        acc.ai_on = True
        await session.commit()
    return {"ok": True}


# ── per-account stats (new chats · AI replies · convos reported) ─────────────
def _since(period: str) -> "datetime | None":
    from datetime import datetime, timezone

    now = utcnow()
    if period == "today":
        return datetime(now.year, now.month, now.day, tzinfo=timezone.utc)
    if period == "week":
        from datetime import timedelta

        return now - timedelta(days=7)
    return None  # all time


async def _stat_counts(session, account_id: int | None, since) -> dict:
    from panel.models import Lead, Message

    chat_where = [Chat.first_in_at.is_not(None)]
    reply_where = [Chat.reported_reply.is_(True), Chat.first_reply_at.is_not(None)]
    msg_where = [Message.sender == "ai"]
    lead_where: list = []
    if account_id is not None:
        chat_where.append(Chat.account_id == account_id)
        reply_where.append(Chat.account_id == account_id)
        msg_where.append(Message.account_id == account_id)
        lead_where.append(Lead.account_id == account_id)
    if since is not None:
        chat_where.append(Chat.first_in_at >= since)
        reply_where.append(Chat.first_reply_at >= since)
        msg_where.append(Message.at >= since)
        lead_where.append(Lead.converted_at >= since)
    new_chats = await session.scalar(select(func.count()).select_from(Chat).where(*chat_where))
    convos = await session.scalar(select(func.count()).select_from(Chat).where(*reply_where))
    replies = await session.scalar(select(func.count()).select_from(Message).where(*msg_where))
    converted = await session.scalar(select(func.count()).select_from(Lead).where(*lead_where))
    return {"new_chats": new_chats or 0, "ai_replies": replies or 0, "convos_reported": convos or 0, "converted": converted or 0}


async def account_stats(session, account_id: int | None) -> dict:
    out = {p: await _stat_counts(session, account_id, _since(p)) for p in ("today", "week", "all")}
    if account_id is not None:
        acc = await session.get(Account, account_id)
        out["last_activity"] = acc.last_msg_at.isoformat() if acc and acc.last_msg_at else None
    return out


@router.get("/{account_id}/stats")
async def get_account_stats(account_id: int, request: Request) -> dict:
    async with _service(request).sessionmaker() as session:
        if not await session.get(Account, account_id):
            raise HTTPException(404, "No such account")
        return await account_stats(session, account_id)


# ── profile editing (name / bio / username / photo) ──────────────────────────
def _require_connected(service, account_id: int):
    client = service.manager.get(account_id)
    if client is None:
        raise HTTPException(409, "Connect the account first (power it on) to edit its profile.")
    return client


@router.get("/{account_id}/profile")
async def get_profile(account_id: int, request: Request) -> dict:
    """Read the current profile live from Telegram, to prefill the edit form."""
    service = _service(request)
    async with service.sessionmaker() as session:
        if not await session.get(Account, account_id):
            raise HTTPException(404, "No such account")
    client = _require_connected(service, account_id)
    try:
        prof = await client.get_profile()
    except TgError as e:
        raise _tg_http(e) from e
    return {"first_name": prof.first_name, "last_name": prof.last_name, "bio": prof.about, "username": prof.username}


class UsernameBody(BaseModel):
    username: str


@router.post("/{account_id}/username-check")
async def username_check(account_id: int, body: UsernameBody, request: Request) -> dict:
    """Live availability check for the form. Returns {available, reason: taken|invalid|null}."""
    service = _service(request)
    async with service.sessionmaker() as session:
        acc = await session.get(Account, account_id)
        if not acc:
            raise HTTPException(404, "No such account")
        current = acc.username
    wanted = body.username.strip().lstrip("@")
    if current and wanted.lower() == current.lower():
        return {"available": True, "reason": None}  # unchanged
    if not USERNAME_RE.fullmatch(wanted):
        return {"available": False, "reason": "invalid"}
    client = _require_connected(service, account_id)
    try:
        ok = await client.check_username(wanted)
    except TgError as e:
        if e.status == "username_invalid":
            return {"available": False, "reason": "invalid"}
        raise _tg_http(e) from e
    return {"available": ok, "reason": None if ok else "taken"}


@router.post("/{account_id}/profile")
async def edit_profile(
    account_id: int,
    request: Request,
    first_name: str = Form(""),
    last_name: str = Form(""),
    bio: str = Form(""),
    username: str = Form(""),
    remove_photo: bool = Form(False),
    photo: UploadFile | None = File(None),
) -> dict:
    service = _service(request)
    async with service.sessionmaker() as session:
        acc = await session.get(Account, account_id)
        if not acc:
            raise HTTPException(404, "No such account")
        current_username = acc.username
    client = _require_connected(service, account_id)

    first_name, last_name, bio = first_name.strip()[:NAME_MAX], last_name.strip()[:NAME_MAX], bio.strip()[:BIO_MAX]
    wanted = username.strip().lstrip("@")
    username_changed = bool(wanted) and wanted.lower() != (current_username or "").lower()
    if username_changed and not USERNAME_RE.fullmatch(wanted):
        raise HTTPException(400, "That username isn't valid (5–32 characters, a–z, 0–9 and _).")

    # Read the fan's photo bytes before any Telegram call, so a bad upload fails early.
    photo_path: Path | None = None
    tmp: tempfile.NamedTemporaryFile | None = None
    if photo is not None and not remove_photo:
        suffix = PHOTO_TYPES.get(photo.content_type or "")
        if suffix is None:
            raise HTTPException(400, "The photo must be a JPG or PNG.")
        data = await photo.read()
        if len(data) > PHOTO_MAX_BYTES:
            raise HTTPException(413, "The photo is too large (max 10 MB).")
        tmp = tempfile.NamedTemporaryFile(suffix=suffix, delete=False)
        tmp.write(data)
        tmp.close()
        photo_path = Path(tmp.name)

    try:
        # 1) Availability first (nothing is applied if it's taken/invalid).
        if username_changed and not await client.check_username(wanted):
            raise HTTPException(409, "That username is already taken.")
        # 2) Name + bio.
        await client.update_profile(first_name, last_name, bio)
        # 3) Username.
        if username_changed:
            await client.set_username(wanted)
        # 4) Photo.
        if remove_photo:
            await client.delete_profile_photo()
        elif photo_path is not None:
            await client.set_profile_photo(str(photo_path))
    except TgError as e:
        raise _tg_http(e) from e
    finally:
        if photo_path is not None:
            photo_path.unlink(missing_ok=True)

    old_username = current_username
    async with service.sessionmaker() as session:
        acc = await session.get(Account, account_id)
        acc.first_name = first_name or None
        if username_changed:
            acc.username = wanted.lower()
        if remove_photo and acc.avatar_path:
            Path(acc.avatar_path).unlink(missing_ok=True)
            acc.avatar_path = None
        acc.updated_at = utcnow()
        await service.log_activity(
            session, "info", "profile_edited", f"@{acc.username or acc.tg_user_id}: profile updated", account_id
        )
        if username_changed:
            await portal.enqueue_account_rename(session, str(acc.tg_user_id), old_username, acc.username, utcnow())
        await session.commit()

    if (photo is not None and not remove_photo):
        await service.refresh_avatar(account_id)  # re-download the new photo into the card

    async with service.sessionmaker() as session:
        acc = await session.get(Account, account_id)
        quiet = await _quiet_hours(session)
        card = _card(acc, quiet, service.manager.is_connected(acc.id))
    return {"ok": True, "username_changed": username_changed, "card": card}


class PowerBody(BaseModel):
    on: bool


@router.post("/{account_id}/power")
async def set_power(account_id: int, body: PowerBody, request: Request) -> dict:
    service = _service(request)
    async with service.sessionmaker() as session:
        acc = await session.get(Account, account_id)
        if not acc:
            raise HTTPException(404, "No such account")
        if body.on and acc.status in ("banned", "revoked"):
            raise HTTPException(409, f"This account is {acc.status} and can't be reconnected.")
        params = service.connect_params(acc) if body.on else None

    await service.cancel_reconnect(account_id)  # this toggle takes over from any background retry
    if body.on:
        # Connect only if we aren't already holding a live client — calling connect() on a
        # connected account would trip the "already connected" guard. Either way we reconcile the
        # DB afterwards, so power_on/status match the live connection and any stale error/off state
        # from an earlier failed toggle is cleared.
        if not service.manager.is_connected(account_id):
            try:
                info = await service.manager.connect(account_id, params, service.on_drop(), service.message_cb(account_id))
            except TgError as e:
                log.warning("power-on failed account=%s status=%s raw=%s detail=%s", account_id, e.status, e.raw, e.detail)
                async with service.sessionmaker() as session:
                    acc = await session.get(Account, account_id)
                    await service.log_activity(
                        session, "error", "connect_failed", f"@{acc.username if acc else account_id}: {e.detail} [{e.raw}]", account_id
                    )
                    acc.power_on = False
                    await session.commit()
                await service._mark_status(account_id, e.status, e.detail, power_off=e.dead)
                raise HTTPException(409, e.detail) from e
            await service._mark_online(account_id, info)
        # The account is connected now (freshly or already): make the DB say so.
        async with service.sessionmaker() as session:
            acc = await session.get(Account, account_id)
            acc.power_on = True
            if acc.status != "online":
                acc.status, acc.status_detail = "online", None
                await service._enqueue_status(session, acc)
            await session.commit()
    else:
        await service.manager.disconnect(account_id)
        async with service.sessionmaker() as session:
            acc = await session.get(Account, account_id)
            old = acc.status
            acc.status, acc.power_on, acc.status_detail = "offline", False, None
            if acc.status != old:
                await service._enqueue_status(session, acc)
            await session.commit()
    return {"ok": True}


class AiBody(BaseModel):
    on: bool


@router.post("/{account_id}/ai")
async def set_ai(account_id: int, body: AiBody, request: Request) -> dict:
    async with _service(request).sessionmaker() as session:
        acc = await session.get(Account, account_id)
        if not acc:
            raise HTTPException(404, "No such account")
        if body.on and acc.profile_id is None:
            raise HTTPException(409, "Pick a preset before switching AI on.")
        acc.ai_on = body.on
        await session.commit()
    return {"ok": True}


class DeleteBody(BaseModel):
    confirm: str = Field(min_length=1)


@router.delete("/{account_id}")
async def delete_account(account_id: int, body: DeleteBody, request: Request) -> dict:
    service = _service(request)
    async with service.sessionmaker() as session:
        acc = await session.get(Account, account_id)
        if not acc:
            raise HTTPException(404, "No such account")
        expected = acc.username or str(acc.tg_user_id)
        if body.confirm.strip().lstrip("@").lower() != expected.lower():
            raise HTTPException(400, "The username you typed doesn't match this account.")

    await service.cancel_reconnect(account_id)  # stop any background retry before we tear it down
    await service.manager.log_out_and_remove(account_id)  # ends the session on Telegram
    async with service.sessionmaker() as session:
        acc = await session.get(Account, account_id)
        if acc:
            if acc.avatar_path:
                try:
                    from pathlib import Path

                    Path(acc.avatar_path).unlink(missing_ok=True)
                except OSError:
                    pass
            await service.log_activity(session, "info", "account_deleted", f"@{acc.username or acc.tg_user_id} removed")
            await portal.enqueue_account_retire(session, str(acc.tg_user_id))  # mark it retired in the portal pool
            await session.delete(acc)  # chats/messages cascade
            await session.commit()
    return {"ok": True}


@router.post("/{account_id}/chats/{peer}/reset")
async def reset_chat(account_id: int, peer: str, request: Request) -> dict:
    """Put a stopped/filtered/converted chat back to `active` so the AI resumes (PLAN.md §5).
    underage is permanent and can't be reset."""
    async with _service(request).sessionmaker() as session:
        chat = await session.scalar(select(Chat).where(Chat.account_id == account_id, Chat.peer_id == peer))
        if not chat:
            raise HTTPException(404, "No such chat")
        if chat.ai_state == "stopped" and chat.ai_state_reason == "underage":
            raise HTTPException(409, "An underage-flagged chat can't be reset.")
        chat.ai_state, chat.ai_state_reason, chat.cooldown_until = "active", None, None
        await session.commit()
    return {"ok": True}


# ── account security (terminate other sessions · set/change 2FA) ─────────────
def _security_http(e: TgError) -> HTTPException:
    if e.status in ("reset_too_fresh", "twofa_wrong", "twofa_needed"):
        return HTTPException(409, e.detail)
    return _tg_http(e)


def _current_twofa(service, acc: Account) -> str | None:
    """The 2FA password we hold for this account (supplier's, from the .json), or None."""
    if not acc.twofa_enc:
        return None
    try:
        return service.crypto.decrypt(acc.twofa_enc)
    except Exception:
        return None  # key changed / corrupt: Telegram will reject the change with a clear error


class TwoFaBody(BaseModel):
    new_password: str = Field(min_length=1, max_length=256)


class BulkBody(BaseModel):
    account_ids: list[int] = Field(min_length=1, max_length=500)


class BulkTwoFaBody(BulkBody):
    new_password: str = Field(min_length=1, max_length=256)


async def _reset_sessions_on(service, account_id: int) -> None:
    client = _require_connected(service, account_id)
    await client.terminate_other_sessions()
    async with service.sessionmaker() as session:
        await service.log_activity(session, "info", "sessions_reset", "terminated all other Telegram sessions", account_id)
        await session.commit()


async def _set_2fa_on(service, account_id: int, new_password: str) -> None:
    async with service.sessionmaker() as session:
        acc = await session.get(Account, account_id)
        if acc is None:
            raise HTTPException(404, "No such account")
        current = _current_twofa(service, acc)
    client = _require_connected(service, account_id)
    await client.set_2fa(current, new_password)
    async with service.sessionmaker() as session:
        acc = await session.get(Account, account_id)
        acc.twofa_enc = service.crypto.encrypt(new_password)  # so a later change has the current password
        acc.updated_at = utcnow()
        await service.log_activity(session, "info", "twofa_set", "2FA password set/changed", account_id)
        await session.commit()


@router.post("/{account_id}/security/reset-sessions")
async def reset_sessions(account_id: int, request: Request) -> dict:
    try:
        await _reset_sessions_on(_service(request), account_id)
    except TgError as e:
        raise _security_http(e) from e
    return {"ok": True}


@router.post("/{account_id}/security/2fa")
async def set_account_2fa(account_id: int, body: TwoFaBody, request: Request) -> dict:
    try:
        await _set_2fa_on(_service(request), account_id, body.new_password)
    except TgError as e:
        raise _security_http(e) from e
    return {"ok": True, "password": body.new_password}  # shown once so the owner can copy it


async def _bulk(service, account_ids: list[int], action, *, gap: float = 0.0) -> list[dict]:
    results = []
    for i, account_id in enumerate(account_ids):
        if i and gap:
            await asyncio.sleep(gap)  # stagger Telegram calls across accounts to stay clear of floods
        async with service.sessionmaker() as session:
            acc = await session.get(Account, account_id)
        username = acc.username if acc else None
        if acc is None:
            results.append({"account_id": account_id, "username": None, "ok": False, "error": "No such account"})
            continue
        try:
            await action(service, account_id)
            results.append({"account_id": account_id, "username": username, "ok": True})
        except HTTPException as e:
            log.warning("bulk action failed for account=%s (@%s): %s", account_id, username, e.detail)
            results.append({"account_id": account_id, "username": username, "ok": False, "error": e.detail})
        except TgError as e:
            log.warning("bulk action failed for account=%s (@%s): %s", account_id, username, e.detail)
            results.append({"account_id": account_id, "username": username, "ok": False, "error": e.detail})
    return results


@router.post("/bulk/reset-sessions")
async def bulk_reset_sessions(body: BulkBody, request: Request) -> dict:
    results = await _bulk(_service(request), body.account_ids, _reset_sessions_on)
    return {"results": results}


@router.post("/bulk/2fa")
async def bulk_set_2fa(body: BulkTwoFaBody, request: Request) -> dict:
    async def action(service, account_id):
        await _set_2fa_on(service, account_id, body.new_password)

    results = await _bulk(_service(request), body.account_ids, action)
    return {"results": results}


# ── privacy + clean profile (per-account + bulk) ─────────────────────────────
def _valid_privacy(rules: dict) -> dict:
    if not rules:
        raise HTTPException(400, "No privacy settings given.")
    for name, value in rules.items():
        if name not in PRIVACY_KEYS or value not in PRIVACY_RULES:
            raise HTTPException(400, f"Unknown privacy setting {name}={value}.")
    return dict(rules)


class PrivacyBody(BaseModel):
    rules: dict[str, str]


class BulkPrivacyBody(BaseModel):
    account_ids: list[int] | None = None
    all: bool = False
    rules: dict[str, str]


class BulkCleanBody(BaseModel):
    account_ids: list[int] | None = None
    all: bool = False


async def _resolve_targets(service, account_ids: list[int] | None, all_: bool) -> list[int]:
    if all_:
        async with service.sessionmaker() as session:
            return [a for (a,) in (await session.execute(select(Account.id).order_by(Account.id))).all()]
    return account_ids or []


# Bulk routes are registered before the /{account_id}/… ones so "bulk" isn't parsed as an id.
@router.post("/bulk/privacy")
async def bulk_privacy(body: BulkPrivacyBody, request: Request) -> dict:
    rules = _valid_privacy(body.rules)
    service = _service(request)
    ids = await _resolve_targets(service, body.account_ids, body.all)

    async def action(svc, account_id):
        await _require_connected(svc, account_id).set_privacy(rules)

    return {"results": await _bulk(service, ids, action, gap=0.3)}


@router.post("/bulk/clean-profile")
async def bulk_clean_profile(body: BulkCleanBody, request: Request) -> dict:
    service = _service(request)
    ids = await _resolve_targets(service, body.account_ids, body.all)

    async def action(svc, account_id):
        client = _require_connected(svc, account_id)
        await client.delete_all_stories()
        await client.remove_profile_music()

    return {"results": await _bulk(service, ids, action, gap=0.3)}


@router.get("/{account_id}/privacy")
async def get_privacy(account_id: int, request: Request) -> dict:
    client = _require_connected(_service(request), account_id)
    try:
        return {"privacy": await client.get_privacy()}
    except TgError as e:
        raise _tg_http(e) from e


@router.post("/{account_id}/privacy")
async def set_privacy(account_id: int, body: PrivacyBody, request: Request) -> dict:
    rules = _valid_privacy(body.rules)
    service = _service(request)
    client = _require_connected(service, account_id)
    try:
        await client.set_privacy(rules)
    except TgError as e:
        raise _tg_http(e) from e
    async with service.sessionmaker() as session:
        await service.log_activity(session, "info", "privacy_set", "privacy updated: " + ", ".join(f"{k}={v}" for k, v in rules.items()), account_id)
        await session.commit()
    try:
        return {"ok": True, "privacy": await client.get_privacy()}
    except TgError:
        return {"ok": True, "privacy": None}


@router.post("/{account_id}/clean-profile")
async def clean_profile(account_id: int, request: Request) -> dict:
    service = _service(request)
    client = _require_connected(service, account_id)
    try:
        stories = await client.delete_all_stories()
        music = await client.remove_profile_music()
    except TgError as e:
        raise _tg_http(e) from e
    async with service.sessionmaker() as session:
        await service.log_activity(session, "info", "profile_cleaned", f"deleted {stories} stories, removed {music} profile songs", account_id)
        await session.commit()
    return {"ok": True, "stories_deleted": stories, "music_removed": music}


@router.get("/{account_id}/avatar")
async def avatar(account_id: int, request: Request) -> FileResponse:
    async with _service(request).sessionmaker() as session:
        acc = await session.get(Account, account_id)
        if not acc or not acc.avatar_path:
            raise HTTPException(404, "No avatar")
        path = acc.avatar_path
    return FileResponse(path, media_type="image/jpeg", headers={"Cache-Control": "no-cache"})
