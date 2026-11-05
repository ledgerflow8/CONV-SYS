"""Writes to the AI message log (`ai_events`, models.AiEvent).

Rows are added to the caller's session, so a row commits together with the change it describes.
"""

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from panel.models import AI_EVENT_TEXT_MAX, AiEvent

# kinds
FAN_MSG = "fan_msg"
AI_REQUEST = "ai_request"
AI_REPLY_SENT = "ai_reply_sent"
AI_SKIPPED = "ai_skipped"

# capital_status
OK = "ok"
CREDIT_OVER = "credit_over"
TIER_FILTERED = "tier_filtered"
ERROR = "error"
AI_OFF = "ai_off"
KILL_SWITCH = "kill_switch"
STATUSES = (OK, CREDIT_OVER, TIER_FILTERED, ERROR, AI_OFF, KILL_SWITCH)

# The setting behind the global AI kill switch (Status page). True = AI may run. The key predates the
# kill switch (it was the "AI replies" master toggle), so a value already saved carries over.
AI_GLOBAL_ON = "ai_global_on"
# When this panel started writing the log (ISO UTC), set once at startup. Stored AI message rows from
# before it are evidence of an AI reply; from then on only the log's ai_reply_sent (ok) rows are.
LOG_STARTED_AT = "ai_log_started_at"


def _cut(s: str | None) -> str | None:
    return s[:AI_EVENT_TEXT_MAX] if s else s


async def log_event(
    session: AsyncSession,
    account_id: int,
    peer_id: str,
    kind: str,
    status: str | None = None,
    *,
    text: str | None = None,
    error: str | None = None,
    collapse: bool = False,
) -> None:
    """Add one ai_events row. `collapse` skips it when the chat's latest row is the same kind and
    status, so a state that repeats every re-probe (a credit pause) logs once, not every 2 minutes."""
    if collapse:
        last = (
            await session.execute(
                select(AiEvent.kind, AiEvent.capital_status)
                .where(AiEvent.account_id == account_id, AiEvent.peer_id == str(peer_id))
                .order_by(AiEvent.id.desc())
                .limit(1)
            )
        ).first()
        if last is not None and tuple(last) == (kind, status):
            return
    session.add(AiEvent(account_id=account_id, peer_id=str(peer_id), kind=kind, capital_status=status, text=_cut(text), error=_cut(error)))
