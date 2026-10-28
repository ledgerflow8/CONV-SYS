"""Status screen: portal sync health, AI state, recent activity, retry and settings (PLAN.md §6)."""

import asyncio
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel
from sqlalchemy import select, update

from panel.auth import require_login
from panel.db import get_setting, set_setting
from panel.housekeeping import compact, disk_usage
from panel.recovery import RecoveryJob, recover
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
    config = request.app.state.outbox.config
    configured = config.configured
    if config.problem:
        last_error = f"{config.problem}. Events are queued, not lost."
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
        "disk": _disk(request),
        "version": VERSION,
    }


def _disk(request: Request) -> dict:
    out = disk_usage(request.app.state.settings.data_dir)
    hk = getattr(request.app.state, "housekeeper", None)
    out["housekeeping"] = {
        "last_run_at": hk.last_run_at.isoformat() if hk and hk.last_run_at else None,
        "last_result": vars(hk.last_result) if hk and hk.last_result else None,
        "last_error": hk.last_error if hk else None,
        "last_checkpoint": (
            {"complete": hk.last_checkpoint.complete, "wal_bytes": hk.last_checkpoint.wal_bytes, "failures_in_a_row": hk.checkpoint_failures}
            if hk and hk.last_checkpoint
            else None
        ),
    }
    return out


@router.post("/db/compact")
async def compact_db(request: Request) -> dict:
    """VACUUM the database (blocks writes while it runs: use at a quiet moment)."""
    try:
        return await compact(request.app.state.engine, request.app.state.settings.data_dir)
    except RuntimeError as e:
        raise HTTPException(409, str(e)) from e


class RecoverBody(BaseModel):
    since: datetime
    dry_run: bool = True


@router.post("/recover")
async def start_recovery(body: RecoverBody, request: Request) -> dict:
    """Re-scan connected accounts' chats since `since` and queue missing convo events (recovery.py).
    Runs in the background; poll GET /recover for progress."""
    current: RecoveryJob | None = request.app.state.recovery
    if current is not None and current.running:
        raise HTTPException(409, "A recovery is already running.")
    since = body.since if body.since.tzinfo else body.since.replace(tzinfo=timezone.utc)
    since = since.astimezone(timezone.utc)
    if since > utcnow():
        raise HTTPException(400, "'since' is in the future.")
    if (utcnow() - since).days > 7:
        raise HTTPException(400, "Recover at most the last 7 days at a time.")
    job = RecoveryJob(since=since, dry_run=body.dry_run)
    request.app.state.recovery = job
    task = asyncio.create_task(recover(request.app.state.service, job))
    request.app.state.background.add(task)
    task.add_done_callback(request.app.state.background.discard)
    return {"recovery": job.as_dict()}


@router.get("/recover")
async def recovery_status(request: Request) -> dict:
    job: RecoveryJob | None = request.app.state.recovery
    return {"recovery": job.as_dict() if job else None}


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
