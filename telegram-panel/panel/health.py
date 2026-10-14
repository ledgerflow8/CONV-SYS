"""The health colour shown on each account card (PLAN.md §3). Worked out, never stored."""

from datetime import datetime, timedelta, timezone

from panel.models import Account

DEAD = {"banned", "revoked", "error"}


def health_color(acc: Account, quiet_after_hours: int, now: datetime | None = None) -> str:
    """red · grey · amber · green."""
    if acc.status in DEAD:
        return "red"
    if not acc.power_on:
        return "grey"
    if acc.status == "limited":
        return "amber"
    if acc.status != "online":
        return "grey"
    now = now or datetime.now(timezone.utc)
    last = acc.last_incoming_at
    if last is None or now - last > timedelta(hours=quiet_after_hours):
        return "amber"
    return "green"
