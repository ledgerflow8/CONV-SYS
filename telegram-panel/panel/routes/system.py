"""Status screen: portal sync health, AI state, recent activity, retry and settings (PLAN.md §6)."""

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel
from sqlalchemy import select, update

from panel.auth import require_login
from panel.db import get_setting, set_setting
from panel.models import Activity, OutboxItem, utcnow
from panel.portal import LAST_ERROR_KEY, LAST_OK_KEY, outbox_counts

router = APIRouter(prefix="/api/system", dependencies=[Depends(require_login)])

VERSION = "step3"

# Settings the Status screen can change, with (default, min, max). bool has no bounds.
SETTINGS = {
    "quiet_after_hours": (12, 1, 168),
    "ai_debounce_sec": (8, 0, 120),
    "typing_cps": (20, 1, 100),
    "ai_global_on": (True, None, None),
}


def _service(request: Request):
    return request.app.state.service


@router.get("/status")
async def status(request: Request) -> dict:
    service = _service(request)
    async with service.sessionmaker() as session:
        counts = await outbox_counts(session)
        last_ok = await get_setting(session, LAST_OK_KEY)
        last_error = await get_setting(session, LAST_ERROR_KEY)
        # The actual failed rows, so the Status screen can show what the portal rejected.
        failed = (
            await session.scalars(
                select(OutboxItem).where(OutboxItem.status == "failed").order_by(OutboxItem.id.desc()).limit(50)
            )
        ).all()
    configured = request.app.state.outbox.config.configured
    ai = request.app.state.ai
    capital = request.app.state.capital
    async with service.sessionmaker() as session:
        ai_global_on = bool(await get_setting(session, "ai_global_on", True))
    paused = ai.credit_over_until if ai and ai.credit_over_until and ai.credit_over_until > utcnow() else None
    return {
        "portal": {
            "configured": configured,
            "pending": counts["pending"],
            "sent": counts["sent"],
            "failed": counts["failed"],
            "last_ok_at": last_ok,
            "last_error": last_error,
            "failed_rows": [
                {"id": r.id, "kind": r.kind, "payload": r.payload, "error": r.last_error, "attempts": r.attempts}
                for r in failed
            ],
        },
        "ai": {
            "configured": bool(capital and capital.configured),
            "global_on": ai_global_on,
            "credit_over_until": paused.isoformat() if paused else None,
            "last_error": ai.last_error if ai else None,
        },
        "version": VERSION,
    }


@router.get("/stats")
async def system_stats(request: Request) -> dict:
    """Overall panel stats (today/week/all) plus Capitalbot's license-wide numbers where configured."""
    from panel.routes.accounts import account_stats

    service = _service(request)
    async with service.sessionmaker() as session:
        panel = await account_stats(session, None)
    capital = request.app.state.capital
    cap: dict = {}
    if capital and capital.configured:
        for ours, theirs in (("today", "today"), ("week", "7days"), ("all", "all")):
            cap[ours] = await capital.statistics(theirs)
    return {"panel": panel, "capital": cap}


class SettingsBody(BaseModel):
    quiet_after_hours: int | None = None
    ai_debounce_sec: int | None = None
    typing_cps: int | None = None
    ai_global_on: bool | None = None


@router.get("/settings")
async def get_settings(request: Request) -> dict:
    async with _service(request).sessionmaker() as session:
        return {"settings": {key: await get_setting(session, key, default) for key, (default, _lo, _hi) in SETTINGS.items()}}


@router.patch("/settings")
async def patch_settings(body: SettingsBody, request: Request) -> dict:
    changes = body.model_dump(exclude_unset=True)
    async with _service(request).sessionmaker() as session:
        for key, value in changes.items():
            if value is None:
                continue
            _default, lo, hi = SETTINGS[key]
            if isinstance(value, bool):
                await set_setting(session, key, value)
            else:
                if lo is not None and not (lo <= value <= hi):
                    raise HTTPException(400, f"{key} must be between {lo} and {hi}")
                await set_setting(session, key, value)
        await session.commit()
        return {"settings": {key: await get_setting(session, key, default) for key, (default, _lo, _hi) in SETTINGS.items()}}


@router.get("/activity")
async def activity(request: Request) -> dict:
    service = _service(request)
    async with service.sessionmaker() as session:
        rows = (await session.scalars(select(Activity).order_by(Activity.id.desc()).limit(100))).all()
    return {
        "activity": [
            {"id": r.id, "at": r.at.isoformat(), "level": r.level, "kind": r.kind, "account_id": r.account_id, "message": r.message}
            for r in rows
        ]
    }


@router.post("/outbox/retry-failed")
async def retry_failed(request: Request) -> dict:
    service = _service(request)
    async with service.sessionmaker() as session:
        result = await session.execute(
            update(OutboxItem)
            .where(OutboxItem.status == "failed")
            .values(status="pending", attempts=0, next_attempt_at=utcnow(), last_error=None)
        )
        await session.commit()
    return {"requeued": result.rowcount}
