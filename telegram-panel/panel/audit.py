"""Qualified-convo audit (client 2026-11-05): `python -m panel audit-qualified --since <ISO> [--live]`.

For every chat the panel reported to the portal as replied since `since`: did the AI actually
deliver a reply? Evidence is the AI log (ai_reply_sent, ok) or, for replies from before that log
existed, a stored AI message row (those rows are kept forever). Chats with neither are what the
portal may have qualified without an AI chat.

`--live` also asks Telegram, for each chat without AI evidence, whether ANY outgoing message exists
after the fan's first message (`has_outgoing`): yes = someone replied by hand / another session /
pre-panel; no = nothing was ever sent. It reaches each chat through its stored access_hash, one
chat at a time with a gap, and waits out short FloodWaits (a long one skips that account).

Read-only: it changes nothing in the panel or the portal. It runs inside the panel process (one
Telegram connection per account), like recovery.py. Totals go back to the CLI; the CSV of chats
with no AI reply is written to DATA_DIR/audit/.
"""

import asyncio
import csv
import logging
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path

from sqlalchemy import select

from panel.models import Account, Chat, Message, utcnow
from panel.portal import iso
from panel.tg.client import TgError

log = logging.getLogger("panel.audit")

LIVE_GAP_SEC = 0.5  # between Telegram reads
MAX_FLOOD_WAIT_SEC = 120  # wait out FloodWaits up to this; a longer one skips the rest of that account
CSV_COLUMNS = ("account", "peer_id", "first_msg_at", "reported_replied_at", "has_outgoing", "ai_reply_logged")


def _bucket() -> dict[str, int]:
    return {"reported": 0, "ai_reply": 0, "no_ai_reply": 0, "no_outgoing": 0}


@dataclass
class AuditJob:
    since: datetime
    live: bool
    out_dir: Path
    started_at: datetime = field(default_factory=utcnow)
    finished_at: datetime | None = None
    checked: int = 0
    live_total: int = 0
    live_done: int = 0
    totals: dict[str, int] = field(default_factory=_bucket)
    by_account: dict[str, dict[str, int]] = field(default_factory=dict)
    by_day: dict[str, dict[str, int]] = field(default_factory=dict)
    csv_path: str | None = None
    notes: list[str] = field(default_factory=list)
    error: str | None = None

    @property
    def running(self) -> bool:
        return self.finished_at is None

    def as_dict(self) -> dict:
        return {
            "since": self.since.isoformat(),
            "live": self.live,
            "running": self.running,
            "started_at": self.started_at.isoformat(),
            "finished_at": self.finished_at.isoformat() if self.finished_at else None,
            "checked": self.checked,
            "live_total": self.live_total,
            "live_done": self.live_done,
            "totals": self.totals,
            "by_account": dict(sorted(self.by_account.items())),
            "by_day": dict(sorted(self.by_day.items())),
            "csv_path": self.csv_path,
            "notes": self.notes[:50],
            "error": self.error,
        }

    def count(self, account: str, day: str, key: str) -> None:
        for b in (self.totals, self.by_account.setdefault(account, _bucket()), self.by_day.setdefault(day, _bucket())):
            b[key] += 1


@dataclass
class _Row:
    account_id: int
    account: str
    peer_id: str
    access_hash: int | None
    first_in: datetime
    replied: datetime
    ai: bool
    has_outgoing: str = "unknown"  # yes · no · unknown (no --live, nothing stored) · offline · skipped · error


async def audit_qualified(service, job: AuditJob) -> AuditJob:
    try:
        rows = await _load(service, job.since)
        job.checked = len(rows)
        missing = [r for r in rows if not r.ai]
        if job.live:
            job.live_total = len(missing)
            await _check_live(service, missing, job)
        for r in rows:
            day = r.replied.strftime("%Y-%m-%d")
            job.count(r.account, day, "reported")
            job.count(r.account, day, "ai_reply" if r.ai else "no_ai_reply")
            if not r.ai and r.has_outgoing == "no":
                job.count(r.account, day, "no_outgoing")
        job.csv_path = str(_write_csv(job, missing))
    except Exception as e:
        log.exception("audit failed")
        job.error = f"{type(e).__name__}: {e}"[:300]
    finally:
        job.finished_at = utcnow()
    return job


async def _load(service, since: datetime) -> list[_Row]:
    out: list[_Row] = []
    async with service.sessionmaker() as s:
        chats = (
            await s.execute(
                select(Chat, Account.username, Account.tg_user_id)
                .join(Account, Account.id == Chat.account_id)
                .where(Chat.reported_reply.is_(True), Chat.first_reply_at >= since, Chat.first_in_at.is_not(None))
                .order_by(Chat.first_reply_at)
            )
        ).all()
        for chat, username, tg_user_id in chats:
            ai = await service.ai_reply_at(s, chat.account_id, chat.peer_id, chat.first_in_at) is not None
            row = _Row(chat.account_id, username or str(tg_user_id), chat.peer_id, chat.access_hash, chat.first_in_at, chat.first_reply_at, ai)
            if not ai:
                # Without --live, a stored outgoing row proves there was one; its absence proves nothing
                # (stored history is pruned after 30 days).
                stored = await s.scalar(
                    select(Message.id)
                    .where(Message.account_id == chat.account_id, Message.peer_id == chat.peer_id, Message.direction == "out", Message.at >= chat.first_in_at)
                    .limit(1)
                )
                if stored is not None:
                    row.has_outgoing = "yes"
            out.append(row)
    return out


async def _check_live(service, rows: list[_Row], job: AuditJob) -> None:
    skip_accounts: dict[int, str] = {}
    for r in rows:
        job.live_done += 1
        if r.account_id in skip_accounts:
            r.has_outgoing = skip_accounts[r.account_id]
            continue
        client = service.manager.get(r.account_id)
        if client is None:
            r.has_outgoing = "offline"
            continue
        try:
            first_in, first_out = await _read(client, r)
        except TgError as e:
            if e.status == "limited":
                skip_accounts[r.account_id] = r.has_outgoing = "skipped"
                job.notes.append(f"@{r.account}: {e.detail}; skipped the rest of this account")
            else:
                r.has_outgoing = "error"
                job.notes.append(f"@{r.account} peer {r.peer_id}: {e.detail}")
            continue
        r.has_outgoing = "yes" if first_out is not None else "no"
        if first_in is None:
            job.notes.append(f"@{r.account} peer {r.peer_id}: no fan message left in Telegram (deleted chat?)")
        await asyncio.sleep(LIVE_GAP_SEC)


async def _read(client, r: _Row):
    """first_exchange, waiting out one FloodWait of up to MAX_FLOOD_WAIT_SEC."""
    try:
        return await client.first_exchange(int(r.peer_id), access_hash=r.access_hash)
    except TgError as e:
        if e.status == "limited" and e.retry_after is not None and e.retry_after <= MAX_FLOOD_WAIT_SEC:
            await asyncio.sleep(e.retry_after + 1)
            return await client.first_exchange(int(r.peer_id), access_hash=r.access_hash)
        raise


def _write_csv(job: AuditJob, rows: list[_Row]) -> Path:
    job.out_dir.mkdir(parents=True, exist_ok=True)
    path = job.out_dir / f"audit-qualified-{job.since:%Y%m%dT%H%MZ}-{job.started_at:%Y%m%dT%H%M%SZ}.csv"
    with open(path, "w", newline="") as fh:
        w = csv.writer(fh)
        w.writerow(CSV_COLUMNS)
        for r in rows:
            w.writerow((r.account, r.peer_id, iso(r.first_in), iso(r.replied), r.has_outgoing, "yes" if r.ai else "no"))
    path.chmod(0o600)  # fan ids: owner-only, like the database
    return path
