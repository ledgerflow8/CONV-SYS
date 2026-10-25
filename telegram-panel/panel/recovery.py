"""Recover convos that failed to save (PLAN.md §12): e.g. while the data disk was full, every
`on_message` commit failed, so new chats, first replies and their portal events were lost.

Re-reads each connected account's private chats active since `since` straight from Telegram,
restores missing message rows (the AI's history), fills a chat's first-message / first-reply times
when they're missing, and queues whatever portal events are now due through the normal outbox.
Idempotent: chats already reported are left alone (`reported_first` / `reported_reply`), and the
portal dedupes on (account, fan) anyway, so running it twice changes nothing.

Runs inside the panel process on the accounts' live connections: a second process must never
connect the same sessions (CLAUDE.md, one connection per account).
"""

import asyncio
import logging
from dataclasses import dataclass, field
from datetime import datetime

from sqlalchemy import select

from panel.models import Account, Activity, Chat, Message, utcnow
from panel.service import Service, _later
from panel.tg.client import TgError

log = logging.getLogger("panel.recovery")

PEER_GAP_SEC = 0.5  # between chats, to stay well inside Telegram's limits
MAX_FLOOD_WAIT_SEC = 30  # wait out short FloodWaits; skip the account on longer ones


@dataclass
class AccountResult:
    account_id: int
    username: str | None
    chats_scanned: int = 0
    messages_restored: int = 0
    first_events: int = 0  # "new convo" events queued that were missing
    reply_events: int = 0  # "replied" events queued that were missing
    unanswered: int = 0  # chats whose newest message is from the fan (no reply since)
    error: str | None = None


@dataclass
class RecoveryJob:
    since: datetime
    dry_run: bool
    started_at: datetime = field(default_factory=utcnow)
    finished_at: datetime | None = None
    accounts_total: int = 0
    accounts: list[AccountResult] = field(default_factory=list)
    error: str | None = None

    @property
    def running(self) -> bool:
        return self.finished_at is None

    def as_dict(self) -> dict:
        totals = {k: sum(getattr(a, k) for a in self.accounts) for k in ("chats_scanned", "messages_restored", "first_events", "reply_events", "unanswered")}
        return {
            "since": self.since.isoformat(),
            "dry_run": self.dry_run,
            "running": self.running,
            "started_at": self.started_at.isoformat(),
            "finished_at": self.finished_at.isoformat() if self.finished_at else None,
            "accounts_done": len(self.accounts),
            "accounts_total": self.accounts_total,
            "totals": totals,
            "accounts": [vars(a) for a in self.accounts],
            "error": self.error,
        }


async def recover(service: Service, job: RecoveryJob) -> RecoveryJob:
    try:
        async with service.sessionmaker() as s:
            accounts = [(a.id, a.username) for a in (await s.scalars(select(Account).order_by(Account.id))).all()]
        targets = [(i, u) for i, u in accounts if service.manager.get(i) is not None]
        job.accounts_total = len(targets)
        for account_id, username in targets:
            res = AccountResult(account_id, username)
            try:
                await _recover_account(service, account_id, job, res)
            except TgError as e:
                res.error = e.detail
            except Exception as e:
                log.exception("recovery failed for account %s", account_id)
                res.error = f"{type(e).__name__}: {e}"[:300]
            job.accounts.append(res)
        if not job.dry_run:
            async with service.sessionmaker() as s:
                t = job.as_dict()["totals"]
                s.add(
                    Activity(
                        level="info",
                        kind="recovery",
                        message=f"Recovered chats since {job.since:%Y-%m-%d %H:%M} UTC: {t['first_events']} new convos and "
                        f"{t['reply_events']} replies queued for the portal, {t['messages_restored']} messages restored.",
                    )
                )
                await s.commit()
    except Exception as e:
        log.exception("recovery failed")
        job.error = f"{type(e).__name__}: {e}"[:300]
    finally:
        job.finished_at = utcnow()
    return job


async def _call(fn, *args):
    """One Telegram read, waiting out a short FloodWait once."""
    try:
        return await fn(*args)
    except TgError as e:
        if e.status == "limited" and e.retry_after and e.retry_after <= MAX_FLOOD_WAIT_SEC:
            await asyncio.sleep(e.retry_after + 1)
            return await fn(*args)
        raise


async def _recover_account(service: Service, account_id: int, job: RecoveryJob, res: AccountResult) -> None:
    client = service.manager.get(account_id)
    if client is None:
        res.error = "not connected"
        return
    peers = await _call(client.recent_peers, job.since)
    for peer in peers:
        scan = await _call(client.scan_chat, int(peer.peer_id), job.since)
        res.chats_scanned += 1
        if scan.first_in is None:
            continue  # the account messaged first and the fan never wrote: not a convo
        async with service.sessionmaker() as s:
            acc = await s.get(Account, account_id)
            if acc is None:
                return
            have = set(
                (
                    await s.scalars(
                        select(Message.tg_msg_id).where(
                            Message.account_id == account_id,
                            Message.peer_id == peer.peer_id,
                            Message.tg_msg_id.in_([m.tg_msg_id for m in scan.recent] or [-1]),
                        )
                    )
                ).all()
            )
            for m in scan.recent:
                if m.tg_msg_id not in have:
                    await service._store_message(s, account_id, m)
                    res.messages_restored += 1
            chat = await s.scalar(select(Chat).where(Chat.account_id == account_id, Chat.peer_id == peer.peer_id))
            if chat is None:
                chat = Chat(account_id=account_id, peer_id=peer.peer_id)
                s.add(chat)
            chat.peer_username = chat.peer_username or scan.peer.username
            chat.peer_name = chat.peer_name or scan.peer.name
            chat.peer_phone = chat.peer_phone or scan.peer.phone
            chat.first_in_at = chat.first_in_at or scan.first_in
            if chat.first_reply_at is None and scan.first_reply is not None:
                chat.first_reply_at = scan.first_reply
            for m in scan.recent:
                if m.out:
                    chat.last_out_at = _later(chat.last_out_at, m.at)
                else:
                    chat.last_in_at = _later(chat.last_in_at, m.at)
                    acc.last_incoming_at = _later(acc.last_incoming_at, m.at)
                acc.last_msg_at = _later(acc.last_msg_at, m.at)
            if scan.recent and not scan.recent[-1].out:
                res.unanswered += 1

            had_first, had_reply = bool(chat.reported_first), bool(chat.reported_reply)
            await service._report_chat(s, acc, chat)
            res.first_events += int(chat.reported_first and not had_first)
            res.reply_events += int(chat.reported_reply and not had_reply)
            if job.dry_run:
                await s.rollback()
            else:
                await s.commit()
        await asyncio.sleep(PEER_GAP_SEC)
