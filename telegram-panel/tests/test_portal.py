"""Step 2: portal sync — signing, event derivation and the outbox worker."""

import json
from datetime import datetime, timezone

import httpx
import pytest

from panel.db import init_db, make_engine, make_sessionmaker
from panel.models import OutboxItem
from panel.portal import OutboxWorker, PortalConfig, enqueue_account_status, iso, sign_body


def at(h, m=0, s=0):
    return datetime(2026, 10, 7, h, m, s, tzinfo=timezone.utc)


# ── Signing matches the portal exactly ──────────────────────────────────────


def test_signature_matches_portal_vector():
    # The same inputs as src/lib/ingest-auth.test.ts, so the panel and portal agree byte for byte.
    body = '{"tgAccount":"a","peerId":"1","firstMsgAt":"2026-10-07T10:00:00Z"}'
    sig = sign_body("shh", "1790000000", body)
    assert sig == "sha256=67a05df246abd40ac7e2fe1c668d5f6bb5f597f3a51782832969c413a9b99012"


def test_iso_is_utc_z_to_the_second():
    assert iso(datetime(2026, 10, 7, 9, 0, 0, 123456, tzinfo=timezone.utc)) == "2026-10-07T09:00:00Z"
    # A non-UTC input is converted.
    from datetime import timedelta

    tz = timezone(timedelta(hours=2))
    assert iso(datetime(2026, 10, 7, 11, 0, 0, tzinfo=tz)) == "2026-10-07T09:00:00Z"


def test_status_url_derives_from_convo_url():
    cfg = PortalConfig("https://www.fansflow.site/api/ingest/convo", "k", "s")
    assert cfg.status_url == "https://www.fansflow.site/api/ingest/account-status"
    assert cfg.url_for("convo") == "https://www.fansflow.site/api/ingest/convo"
    assert cfg.url_for("account_status") == "https://www.fansflow.site/api/ingest/account-status"
    assert cfg.configured
    assert not PortalConfig(None, "k", "s").configured  # no address set: the outbox stays idle


# ── The outbox worker ───────────────────────────────────────────────────────


@pytest.fixture
async def sm(tmp_path):
    engine = make_engine(tmp_path / "db" / "panel.db")
    await init_db(engine)
    yield make_sessionmaker(engine)
    await engine.dispose()


def _worker(sm, handler, batch=200):
    cfg = PortalConfig("https://portal.test/api/ingest/convo", "key_live", "secret")
    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    w = OutboxWorker(sm, cfg, client=client)
    w._batch = batch
    return w


async def _add(sm, kind, payload, dedupe=None):
    async with sm() as s:
        s.add(OutboxItem(kind=kind, dedupe_key=dedupe, payload=payload))
        await s.commit()


async def _rows(sm):
    async with sm() as s:
        from sqlalchemy import select

        return (await s.scalars(select(OutboxItem).order_by(OutboxItem.id))).all()


async def test_worker_marks_sent_and_failed_from_results(sm):
    seen = {}

    def handler(req: httpx.Request):
        seen["ts"] = req.headers["X-Timestamp"]
        seen["sig"] = req.headers["X-Signature"]
        seen["body"] = req.content.decode()
        seen["auth"] = req.headers["Authorization"]
        return httpx.Response(200, json={"results": [{"index": 0, "ok": True}, {"index": 1, "ok": False, "error": "bad country"}]})

    await _add(sm, "convo", {"tgAccount": "a", "peerId": "1", "firstMsgAt": "2026-10-07T10:00:00Z"})
    await _add(sm, "convo", {"tgAccount": "a", "peerId": "2", "firstMsgAt": "2026-10-07T10:00:00Z"})
    w = _worker(sm, handler)
    assert await w.tick() is True

    rows = await _rows(sm)
    assert rows[0].status == "sent" and rows[0].sent_at is not None
    assert rows[1].status == "failed" and rows[1].last_error == "bad country"
    # Signed what it sent, with the portal's bearer token.
    assert seen["auth"] == "Bearer key_live"
    assert seen["sig"] == sign_body("secret", seen["ts"], seen["body"])
    assert json.loads(seen["body"])["events"][0]["peerId"] == "1"
    await w._client.aclose()


async def test_worker_retries_on_5xx_without_losing_rows(sm):
    def handler(req):
        return httpx.Response(502, text="bad gateway")

    await _add(sm, "convo", {"tgAccount": "a", "peerId": "1", "firstMsgAt": "2026-10-07T10:00:00Z"})
    w = _worker(sm, handler)
    await w.tick()
    rows = await _rows(sm)
    assert rows[0].status == "pending"  # still queued; keeps trying
    assert rows[0].attempts == 1
    assert "502" in rows[0].last_error
    assert rows[0].next_attempt_at > datetime(2026, 1, 1, tzinfo=timezone.utc)  # pushed into the future
    await w._client.aclose()


async def test_worker_halves_batch_on_413(sm):
    def handler(req):
        return httpx.Response(413, text="too large")

    for i in range(4):
        await _add(sm, "convo", {"tgAccount": "a", "peerId": str(i), "firstMsgAt": "2026-10-07T10:00:00Z"})
    w = _worker(sm, handler, batch=200)
    await w.tick()
    assert w._batch == 100  # halved for next time
    assert all(r.status == "pending" for r in await _rows(sm))
    await w._client.aclose()


async def test_worker_idle_when_not_configured(sm):
    cfg = PortalConfig("https://portal.test/api/ingest/convo", None, None)
    w = OutboxWorker(sm, cfg)
    await _add(sm, "convo", {"tgAccount": "a", "peerId": "1", "firstMsgAt": "2026-10-07T10:00:00Z"})
    assert await w.tick() is False  # nothing sent; no client needed
    assert (await _rows(sm))[0].status == "pending"


async def test_worker_sends_one_kind_per_tick(sm):
    kinds = []

    def handler(req):
        kinds.append(json.loads(req.content.decode())["events"][0])
        return httpx.Response(200, json={"results": [{"index": 0, "ok": True}]})

    await _add(sm, "convo", {"tgAccount": "a", "peerId": "1", "firstMsgAt": "2026-10-07T10:00:00Z"})
    async with sm() as s:
        await enqueue_account_status(s, "a", "123", "banned", at(9), "gone")
        await s.commit()
    w = _worker(sm, handler)
    await w.tick()  # convo first (older id)
    await w.tick()  # then account_status
    assert "firstMsgAt" in kinds[0]
    assert kinds[1]["status"] == "banned"
    await w._client.aclose()


async def test_a_redirecting_portal_url_is_reported_not_followed(sm):
    """2026-10-28: the portal moved to www.fansflow.site and the bare domain 308-redirects there."""
    from sqlalchemy import select as _select

    from panel.models import Setting

    calls = []

    def handler(req: httpx.Request):
        calls.append(str(req.url))
        return httpx.Response(308, headers={"location": "https://www.fansflow.site/api/ingest/convo"})

    await _add(sm, "convo", {"tgAccount": "a", "peerId": "1", "firstMsgAt": "2026-10-07T10:00:00Z"})
    w = _worker(sm, handler)
    await w.tick()
    assert len(calls) == 1  # not followed: a signed POST only goes where it's configured to
    row = (await _rows(sm))[0]
    assert row.status == "pending" and row.last_error == "portal redirected to https://www.fansflow.site/api/ingest/convo"
    async with sm() as s:
        err = (await s.scalar(_select(Setting).where(Setting.key == "portal_last_error"))).value
    assert "PORTAL_INGEST_URL redirects (308) to https://www.fansflow.site/api/ingest/convo" in err
    await w._client.aclose()


def test_portal_ingest_url_is_tidied_and_problems_are_explained(tmp_path):
    from tests.conftest import make_settings

    assert make_settings(tmp_path).portal_ingest_url is None  # no built-in default domain
    ok = make_settings(tmp_path, portal_ingest_url=" https://www.fansflow.site/api/ingest/convo/ ")
    assert ok.portal_ingest_url == "https://www.fansflow.site/api/ingest/convo"
    assert PortalConfig(ok.portal_ingest_url, "k", "s").problem is None
    # A wrong address never stops the panel; it keeps the outbox idle with a reason.
    for bad, why in (
        (None, "isn't set"),
        ("http://www.fansflow.site/api/ingest/convo", "must start with https://"),
        ("https://www.fansflow.site", "must end with /api/ingest/convo"),
    ):
        cfg = PortalConfig(bad, "k", "s")
        assert not cfg.configured and why in cfg.problem


def test_status_says_why_the_outbox_is_idle(client):
    # conftest's panel has no PORTAL_INGEST_* set
    from tests.conftest import login, set_password

    set_password(client)
    login(client)
    p = client.get("/api/system/status").json()["portal"]
    assert p["configured"] is False
    assert "PORTAL_INGEST_URL isn't set" in p["last_error"] and "queued, not lost" in p["last_error"]
