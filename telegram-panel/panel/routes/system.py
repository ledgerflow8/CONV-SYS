"""Status screen: portal sync health, recent activity, and a manual retry (PLAN.md §6)."""

from fastapi import APIRouter, Depends, Request
from sqlalchemy import select, update

from panel.auth import require_login
from panel.db import get_setting
from panel.models import Activity, OutboxItem, utcnow
from panel.portal import LAST_ERROR_KEY, LAST_OK_KEY, outbox_counts

router = APIRouter(prefix="/api/system", dependencies=[Depends(require_login)])

VERSION = "step2"


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
        "version": VERSION,
    }


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
