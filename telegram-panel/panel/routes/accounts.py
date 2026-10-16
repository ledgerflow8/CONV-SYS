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
from panel.tg.client import TgError

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
        "has_avatar": bool(acc.avatar_path),
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

    counts = {"all": len(cards), "green": 0, "amber": 0, "red": 0, "grey": 0}
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
        if acc.profile_id is not None:
            prof = await session.get(Profile, acc.profile_id)
            card["profile_name"] = prof.name if prof else None
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
        card["chats"] = [
            {
                "peer_id": c.peer_id,
                "peer_name": c.peer_name,
                "peer_username": c.peer_username,
                "ai_state": c.ai_state,
                "ai_state_reason": c.ai_state_reason,
                "cooldown_until": c.cooldown_until.isoformat() if c.cooldown_until else None,
                "last_in_at": c.last_in_at.isoformat() if c.last_in_at else None,
                "last_out_at": c.last_out_at.isoformat() if c.last_out_at else None,
            }
            for c in chats
        ]
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
            raise HTTPException(409, "Pick a persona before switching AI on.")
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


@router.get("/{account_id}/avatar")
async def avatar(account_id: int, request: Request) -> FileResponse:
    async with _service(request).sessionmaker() as session:
        acc = await session.get(Account, account_id)
        if not acc or not acc.avatar_path:
            raise HTTPException(404, "No avatar")
        path = acc.avatar_path
    return FileResponse(path, media_type="image/jpeg", headers={"Cache-Control": "no-cache"})
