"""Everything bound for the portal goes through the outbox (CLAUDE.md).

This module owns the portal contract: it derives convo and account-status events into the outbox,
signs each batch at send time (never at enqueue time), and ships it with retry. The signature and
body format match the portal's `src/lib/ingest-auth.ts` and `src/lib/ingest.ts` exactly.
"""

import asyncio
import hashlib
import hmac
import json
import logging
import time
from dataclasses import dataclass
from datetime import datetime, timezone

import httpx
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from panel.db import set_setting
from panel.models import OutboxItem, utcnow

log = logging.getLogger("panel.portal")

BACKOFF_BASE_SEC = 10
BACKOFF_CAP_SEC = 30 * 60
DEFAULT_BATCH = 200
LAST_OK_KEY = "portal_last_ok_at"
LAST_ERROR_KEY = "portal_last_error"


def iso(dt: datetime) -> str:
    """ISO 8601 UTC with a Z, to the second — what the portal's isoDate regex accepts."""
    return dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def sign_body(secret: str, timestamp: str, body: str) -> str:
    """Matches signIngestBody(secret, timestamp, body) in the portal."""
    digest = hmac.new(secret.encode(), f"{timestamp}.{body}".encode(), hashlib.sha256).hexdigest()
    return f"sha256={digest}"


@dataclass(frozen=True)
class PortalConfig:
    convo_url: str | None  # PORTAL_INGEST_URL, e.g. https://www.fansflow.site/api/ingest/convo
    api_key: str | None
    hmac_secret: str | None

    @property
    def status_url(self) -> str:
        # …/api/ingest/convo → …/api/ingest/account-status
        return (self.convo_url or "").rsplit("/", 1)[0] + "/account-status"

    @property
    def stats_url(self) -> str:
        # …/api/ingest/convo → …/api/ingest/stats (the portal's read-only week breakdown)
        return (self.convo_url or "").rsplit("/", 1)[0] + "/stats"

    @property
    def problem(self) -> str | None:
        """Why the outbox can't send, or None."""
        url = self.convo_url
        if not url:
            return "PORTAL_INGEST_URL isn't set (e.g. https://www.fansflow.site/api/ingest/convo)"
        if not (url.startswith("https://") or url.startswith("http://localhost")):
            return f"PORTAL_INGEST_URL must start with https:// (it's {url})"
        if not url.endswith("/api/ingest/convo"):
            return f"PORTAL_INGEST_URL must end with /api/ingest/convo (it's {url})"
        if not (self.api_key and self.hmac_secret):
            return "PORTAL_INGEST_API_KEY / PORTAL_INGEST_HMAC_SECRET aren't set"
        return None

    @property
    def configured(self) -> bool:
        return self.problem is None

    def url_for(self, kind: str) -> str:
        return self.status_url if kind == "account_status" else (self.convo_url or "")


async def fetch_week_stats(client: httpx.AsyncClient, config: PortalConfig) -> dict | None:
    """The portal's authoritative current-week convo breakdown (Qualified/Pending/Rejected), so the
    panel's 'this week' matches the VA dashboard. Signed GET (empty body). None if unconfigured/unreachable."""
    if not config.configured:
        return None
    ts = str(int(time.time()))
    headers = {
        "Authorization": f"Bearer {config.api_key}",
        "X-Timestamp": ts,
        "X-Signature": sign_body(config.hmac_secret, ts, ""),  # HMAC over "<ts>." with an empty body
    }
    try:
        resp = await client.get(config.stats_url, headers=headers, timeout=10)
    except httpx.HTTPError:
        return None
    if resp.status_code != 200:
        return None
    try:
        return resp.json()
    except ValueError:
        return None


# ── Event derivation (enqueue only; the worker signs and sends) ──────────────


async def _enqueue(session: AsyncSession, kind: str, dedupe_key: str | None, payload: dict) -> None:
    """Add an outbox row. If a row with the same key is still pending, refresh it instead of
    queueing a duplicate (a later event fills gaps; the portal merges and never erases)."""
    if dedupe_key is not None:
        pending = await session.scalar(
            select(OutboxItem).where(OutboxItem.dedupe_key == dedupe_key, OutboxItem.status == "pending")
        )
        if pending is not None:
            pending.payload = payload
            return
    session.add(OutboxItem(kind=kind, dedupe_key=dedupe_key, payload=payload))


def convo_event(
    tg_account: str,
    peer_id: str,
    first_in_at: datetime,
    *,
    tg_user_id: str,
    peer_phone: str | None,
    replied_at: datetime | None,
    tier: str | None = None,
) -> dict:
    # tgUserId is the stable key: the portal matches on it so a convo still lands on the right account
    # after a username change (the account's username can move; its numeric id never does).
    event: dict = {"tgAccount": tg_account, "tgUserId": tg_user_id, "peerId": peer_id, "firstMsgAt": iso(first_in_at)}
    if peer_phone:
        event["peerPhone"] = peer_phone
    if replied_at is not None:
        event["repliedAt"] = iso(replied_at)
    if tier:
        # Capitalbot's tier verdict ("T1" / "NON_T1"), used by the portal only when the phone is hidden.
        event["tier"] = tier
    return event


async def enqueue_convo(
    session: AsyncSession, tg_account: str, tg_user_id: str, chat, *, with_reply: bool, tier: str | None = None, suffix: str | None = None
) -> None:
    kind_suffix = suffix or ("reply" if with_reply else "first")
    payload = convo_event(
        tg_account,
        chat.peer_id,
        chat.first_in_at,
        tg_user_id=tg_user_id,
        peer_phone=chat.peer_phone,
        replied_at=chat.first_reply_at if with_reply else None,
        tier=tier,
    )
    # Dedupe on the stable numeric id, not the username, so a rename can't split a chat into two rows.
    await _enqueue(session, "convo", f"convo:{tg_user_id}:{chat.peer_id}:{kind_suffix}", payload)


async def enqueue_account_status(
    session: AsyncSession, tg_account: str, tg_user_id: str, status: str, at: datetime, detail: str | None
) -> None:
    payload: dict = {"tgAccount": tg_account, "tgUserId": tg_user_id, "status": status, "at": iso(at)}
    if detail:
        payload["detail"] = detail[:500]
    # No dedupe key: each status change is its own row, sent in order.
    await _enqueue(session, "account_status", None, payload)


async def enqueue_account_register(
    session: AsyncSession, tg_user_id: str, username: str | None, phone: str | None, link: str | None
) -> None:
    """Register/refresh an account in the portal's pool (keyed by numeric id; arrives unassigned).
    Same account-status endpoint + auth; discriminated by action."""
    payload = {
        "action": "register",
        "tgUserId": tg_user_id,
        "tgAccount": username or tg_user_id,
        "username": username,
        "phone": phone,
        "link": link,
    }
    await _enqueue(session, "account_status", f"register:{tg_user_id}", payload)


async def enqueue_account_retire(session: AsyncSession, tg_user_id: str) -> None:
    """Mark an account retired in the portal when it's removed from the panel."""
    payload = {"action": "retire", "tgUserId": tg_user_id, "tgAccount": tg_user_id}
    await _enqueue(session, "account_status", f"retire:{tg_user_id}", payload)


async def enqueue_account_rename(
    session: AsyncSession, tg_user_id: str, old_username: str | None, new_username: str | None, at: datetime
) -> None:
    """Tell the portal an account's username changed, so the pool and the VA's tracking link follow.
    Goes to the account-status endpoint (same auth); the portal keys on the numeric id."""
    payload = {
        "tgUserId": tg_user_id,
        "tgAccount": new_username or tg_user_id,
        "oldUsername": old_username,
        "newUsername": new_username,
        "at": iso(at),
    }
    await _enqueue(session, "account_status", f"rename:{tg_user_id}:{new_username}", payload)


# ── Outbox worker ────────────────────────────────────────────────────────────


class OutboxWorker:
    """Every `interval` seconds, send the oldest due rows of one kind as a signed batch."""

    def __init__(
        self,
        sessionmaker: async_sessionmaker[AsyncSession],
        config: PortalConfig,
        interval: float = 5.0,
        client: httpx.AsyncClient | None = None,
    ):
        self.sessionmaker = sessionmaker
        self.config = config
        self.interval = interval
        self._client = client
        self._owns_client = client is None
        self._batch = DEFAULT_BATCH
        self._warned_unconfigured = False

    async def run(self) -> None:
        if self._client is None:
            self._client = httpx.AsyncClient(timeout=30)
        try:
            while True:
                try:
                    await self.tick()
                except asyncio.CancelledError:
                    raise
                except Exception:
                    log.exception("outbox tick failed")
                await asyncio.sleep(self.interval)
        finally:
            if self._owns_client and self._client is not None:
                await self._client.aclose()

    async def tick(self) -> bool:
        """Send one batch. Returns True if it sent (or tried to send) rows, False if idle."""
        if not self.config.configured:
            if not self._warned_unconfigured:
                # Status shows config.problem directly (no DB write here: see housekeeping's shutdown note).
                log.warning("portal ingest not configured: %s; outbox idle", self.config.problem)
                self._warned_unconfigured = True
            return False
        if self._client is None:
            self._client = httpx.AsyncClient(timeout=30)

        async with self.sessionmaker() as session:
            now = utcnow()
            first = await session.scalar(
                select(OutboxItem)
                .where(OutboxItem.status == "pending", OutboxItem.next_attempt_at <= now)
                .order_by(OutboxItem.id)
                .limit(1)
            )
            if first is None:
                return False
            kind = first.kind
            rows = (
                await session.scalars(
                    select(OutboxItem)
                    .where(
                        OutboxItem.status == "pending",
                        OutboxItem.next_attempt_at <= now,
                        OutboxItem.kind == kind,
                    )
                    .order_by(OutboxItem.id)
                    .limit(self._batch)
                )
            ).all()

            body = json.dumps({"events": [r.payload for r in rows]}, ensure_ascii=False)
            ts = str(int(time.time()))
            headers = {
                "Authorization": f"Bearer {self.config.api_key}",
                "X-Timestamp": ts,
                "X-Signature": sign_body(self.config.hmac_secret, ts, body),
                "Content-Type": "application/json",
            }
            try:
                resp = await self._client.post(self.config.url_for(kind), content=body.encode(), headers=headers)
            except httpx.RequestError as e:
                await self._retry_all(session, rows, f"network: {type(e).__name__}")
                await session.commit()
                return True

            await self._handle_response(session, rows, resp)
            await session.commit()
            return True

    async def _handle_response(self, session: AsyncSession, rows: list[OutboxItem], resp: httpx.Response) -> None:
        if resp.status_code == 200:
            try:
                data = resp.json()
            except ValueError:
                await self._retry_all(session, rows, "200 but body wasn't JSON")
                return
            results = data.get("results") if isinstance(data, dict) else None
            by_index = {r["index"]: r for r in results if isinstance(r, dict) and "index" in r} if isinstance(results, list) else {}
            for i, row in enumerate(rows):
                r = by_index.get(i)
                if r is None:
                    self._retry_one(row, "no result for this row")  # transient; try again
                elif r.get("ok"):
                    row.status, row.sent_at, row.last_error = "sent", utcnow(), None
                else:
                    row.status, row.last_error = "failed", str(r.get("error"))[:1000]
            self._batch = DEFAULT_BATCH
            await set_setting(session, LAST_OK_KEY, iso(utcnow()))
            return

        if resp.status_code == 413:
            self._batch = max(1, self._batch // 2)
            await self._retry_all(session, rows, "413 payload too large; halving batch")
            return

        if resp.status_code in (301, 302, 303, 307, 308):
            # A redirect means PORTAL_INGEST_URL is an old or non-canonical address (e.g. the bare domain
            # when the portal lives on www). Never follow it: the signed POST must go to the right place.
            where = resp.headers.get("location", "?")
            await self._retry_all(session, rows, f"portal redirected to {where}")
            await set_setting(
                session,
                LAST_ERROR_KEY,
                f"PORTAL_INGEST_URL redirects ({resp.status_code}) to {where} — set it to the portal's real address (at {iso(utcnow())})",
            )
            return

        if resp.status_code in (401, 503):
            # Misconfiguration or the portal is down: keep the rows, surface it on Status.
            await self._retry_all(session, rows, f"portal returned {resp.status_code}")
            await set_setting(session, LAST_ERROR_KEY, f"portal returned {resp.status_code} at {iso(utcnow())}")
            return

        # 5xx and anything else: back off and keep trying.
        await self._retry_all(session, rows, f"portal returned {resp.status_code}")

    def _retry_one(self, row: OutboxItem, error: str) -> None:
        row.attempts += 1
        delay = min(BACKOFF_CAP_SEC, BACKOFF_BASE_SEC * (2 ** (row.attempts - 1)))
        row.next_attempt_at = utcnow().replace(microsecond=0) + _seconds(delay)
        row.last_error = error[:1000]

    async def _retry_all(self, session: AsyncSession, rows: list[OutboxItem], error: str) -> None:
        for row in rows:
            self._retry_one(row, error)


def _seconds(n: int):
    from datetime import timedelta

    return timedelta(seconds=n)


async def outbox_counts(session: AsyncSession) -> dict[str, int]:
    rows = (await session.execute(select(OutboxItem.status, func.count()).group_by(OutboxItem.status))).all()
    counts = {s: 0 for s in ("pending", "sent", "failed")}
    for status, n in rows:
        counts[status] = n
    return counts
