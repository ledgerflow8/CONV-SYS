import logging

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field
from sqlalchemy import func, or_, select

from panel.auth import require_login
from panel.db import get_setting
from panel.health import health_color
from panel.models import Account
from panel.tg.client import TgError

router = APIRouter(prefix="/api/accounts", dependencies=[Depends(require_login)])

log = logging.getLogger("panel.routes.accounts")

DEFAULT_QUIET_HOURS = 12


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
        card["profile_overrides"] = acc.profile_overrides
    return card


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


@router.get("/{account_id}/avatar")
async def avatar(account_id: int, request: Request) -> FileResponse:
    async with _service(request).sessionmaker() as session:
        acc = await session.get(Account, account_id)
        if not acc or not acc.avatar_path:
            raise HTTPException(404, "No avatar")
        path = acc.avatar_path
    return FileResponse(path, media_type="image/jpeg", headers={"Cache-Control": "no-cache"})
