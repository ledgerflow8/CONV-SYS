"""One-off re-process (client 2026-11-03): chats we stopped as `tierFiltered` whose OWN country is a
confirmed Tier-1 were dropped wrongly — Capitalbot's name-based tier guess overrode our reliable
country, so real Tier-1 fans got no reply and sit Pending in the portal.

This re-resolves each stopped chat's country on the live connection (visible phone → Telegram
PeerSettings). When it's a reliable Tier-1, it re-opens the chat (ai_state → active) and triggers a
fresh AI turn so the fan is finally answered — with the persona's no-filter preset if one is set.

Runs inside the panel process on the accounts' live connections (CLAUDE.md: one connection per
account), like recovery.py. Dry run by default: it reports the candidates and changes nothing.
"""

import asyncio
import logging
from dataclasses import dataclass, field
from datetime import datetime

from sqlalchemy import select

from panel import tier
from panel.db import get_setting
from panel.models import Account, Chat, utcnow

log = logging.getLogger("panel.reprocess")

PEER_GAP_SEC = 0.3  # between chats, to stay well inside Telegram's limits
CANDIDATE_CAP = 500  # how many candidates to list back (the action still runs on all of them)


@dataclass
class ReprocessJob:
    dry_run: bool
    started_at: datetime = field(default_factory=utcnow)
    finished_at: datetime | None = None
    scanned: int = 0  # tierFiltered chats examined
    reliable_t1: int = 0  # of those, a confirmed Tier-1 by our own country
    reopened: int = 0  # re-opened and re-queued for a reply (0 on a dry run)
    candidates: list[dict] = field(default_factory=list)  # {account_id, peer_id, username, country}
    errors: list[str] = field(default_factory=list)

    @property
    def running(self) -> bool:
        return self.finished_at is None

    def as_dict(self) -> dict:
        return {
            "dry_run": self.dry_run,
            "running": self.running,
            "started_at": self.started_at.isoformat(),
            "finished_at": self.finished_at.isoformat() if self.finished_at else None,
            "scanned": self.scanned,
            "reliable_t1": self.reliable_t1,
            "reopened": self.reopened,
            "candidates": self.candidates[:CANDIDATE_CAP],
            "errors": self.errors[:50],
        }


async def reprocess_tierfiltered(service, job: ReprocessJob) -> ReprocessJob:
    try:
        async with service.sessionmaker() as s:
            tier1 = await get_setting(s, "tier1_countries", None) or tier.DEFAULT_TIER1
            targets = [
                (c.account_id, c.peer_id)
                for c in (
                    await s.scalars(
                        select(Chat).where(Chat.ai_state == "filtered", Chat.ai_state_reason == "tierFiltered")
                    )
                ).all()
            ]
        tier1 = list(tier1)
        job.scanned = len(targets)
        for account_id, peer_id in targets:
            if service.manager.get(account_id) is None:
                continue  # can't resolve or reply without the live connection; leave it for next time
            try:
                info = await service.resolve_peer_country(account_id, peer_id)
            except Exception as e:  # noqa: BLE001 — one bad chat must not stop the sweep
                job.errors.append(f"{account_id}/{peer_id}: {type(e).__name__}")
                continue
            country = info.get("country")
            if info.get("source") not in tier.RELIABLE_SOURCES or not country or country not in tier1:
                continue
            job.reliable_t1 += 1
            async with service.sessionmaker() as s:
                acc = await s.get(Account, account_id)
                chat = await s.scalar(select(Chat).where(Chat.account_id == account_id, Chat.peer_id == peer_id))
                if chat is None:
                    continue
                job.candidates.append(
                    {"account_id": account_id, "peer_id": peer_id, "username": acc.username if acc else None, "country": country}
                )
                reopen = not job.dry_run and chat.ai_state == "filtered" and chat.ai_state_reason == "tierFiltered"
                if reopen:
                    chat.ai_state, chat.ai_state_reason = "active", None
                    await service.log_activity(
                        s, "info", "tier_reopen", f"@{peer_id}: re-opened (country {country} is Tier 1) and re-queued for a reply", account_id
                    )
                    await s.commit()
                    job.reopened += 1
                else:
                    await s.rollback()
            if reopen and service.ai is not None:
                try:
                    await service.ai.run_turn(account_id, peer_id)  # answer now, using the no-filter preset if set
                except Exception:
                    log.exception("reprocess turn failed account=%s peer=%s", account_id, peer_id)
            await asyncio.sleep(PEER_GAP_SEC)
    except Exception as e:  # noqa: BLE001
        log.exception("reprocess failed")
        job.errors.append(f"{type(e).__name__}: {e}"[:200])
    finally:
        job.finished_at = utcnow()
    return job
