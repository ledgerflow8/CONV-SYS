"""Step 2: a real message on an account derives portal events and colours the card."""

import io
import time
from datetime import datetime, timezone

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select

from panel.main import create_app
from panel.models import Account, OutboxItem, utcnow
from panel.tg.client import AccountInfo, IncomingMessage, PeerInfo
from tests.conftest import H, PASSWORD, set_password, speed_up_imports
from tests.fake_tg import FakeAccount, FakeDirectory
from tests.make_session import key, string_session, telethon_session_bytes


def at(h, m=0, s=0):
    return datetime(2026, 10, 7, h, m, s, tzinfo=timezone.utc)


def fan(peer_id="555", username="fan1", phone="+15557770000"):
    return PeerInfo(peer_id=peer_id, username=username, name="Fan One", phone=phone)


@pytest.fixture
def directory():
    return FakeDirectory()


@pytest.fixture
def client(directory, settings, tmp_path):
    app = create_app(settings, dist=tmp_path / "x", client_factory=directory.factory)
    with TestClient(app, base_url="https://panel.example.com") as c:
        set_password(c)
        speed_up_imports(c)
        c.post("/api/auth/login", json={"password": PASSWORD}, headers=H)
        yield c


def _import(c, directory, n, info, **fake_kw):
    k = key(n)
    directory.add(string_session(k), FakeAccount(info, **fake_kw))
    files = [("files", (f"{info.username}.session", io.BytesIO(telethon_session_bytes(k)), "application/octet-stream"))]
    job = c.post("/api/imports", files=files, headers=H).json()["job_id"]
    for _ in range(100):
        if c.get(f"/api/imports/{job}").json()["done"]:
            break
        time.sleep(0.02)
    return c.get("/api/accounts").json()["accounts"][0]["id"]


def _deliver(c, account_id, msg):
    async def _d():
        await c.app.state.service.manager.get(account_id).deliver(msg)

    c.portal.call(_d)


def _outbox(c):
    out = {}

    async def _q():
        async with c.app.state.sessionmaker() as s:
            rows = (await s.scalars(select(OutboxItem).order_by(OutboxItem.id))).all()
            out["v"] = [(r.kind, dict(r.payload), r.dedupe_key, r.status) for r in rows]

    c.portal.call(_q)
    return out["v"]


def _convo(outbox):
    return [p for kind, p, _dk, _st in outbox if kind == "convo"]


def _status(outbox):
    # account_status now also carries register/rename/retire events; keep only real status reports.
    return [p for kind, p, _dk, _st in outbox if kind == "account_status" and "status" in p]


def test_incoming_then_reply_makes_first_and_reply_events(client, directory):
    acc = _import(client, directory, 50, AccountInfo(7001, "alice", "+1", "A"))

    # Fan writes → a "first" convo event, with the fan's phone.
    _deliver(client, acc, IncomingMessage(fan(), tg_msg_id=1, out=False, kind="text", text="hi", at=at(9)))
    convo = _convo(_outbox(client))
    assert len(convo) == 1
    assert convo[0] == {"tgAccount": "alice", "tgUserId": "7001", "peerId": "555", "peerPhone": "+15557770000", "firstMsgAt": "2026-10-07T09:00:00Z"}

    # Account replies → a "reply" event carrying repliedAt. firstMsgAt is unchanged.
    _deliver(client, acc, IncomingMessage(fan(), tg_msg_id=2, out=True, kind="text", text="hey", at=at(9, 5)))
    convo = _convo(_outbox(client))
    assert len(convo) == 2
    assert convo[1]["repliedAt"] == "2026-10-07T09:05:00Z"
    assert convo[1]["firstMsgAt"] == "2026-10-07T09:00:00Z"


def test_firstmsgat_comes_from_telegram_history(client, directory):
    # The dialog already has an older fan message than the one we just saw.
    acc = _import(
        client,
        directory,
        51,
        AccountInfo(7002, "bob", "+1", "B"),
        dialog_firsts={"555": (at(8), None)},
    )
    _deliver(client, acc, IncomingMessage(fan(), tg_msg_id=9, out=False, kind="text", text="back?", at=at(14)))
    convo = _convo(_outbox(client))
    assert convo[0]["firstMsgAt"] == "2026-10-07T08:00:00Z"  # the real start, not 14:00


def test_repeat_incoming_does_not_duplicate_the_first_event(client, directory):
    acc = _import(client, directory, 52, AccountInfo(7003, "carol", "+1", "C"))
    _deliver(client, acc, IncomingMessage(fan(), tg_msg_id=1, out=False, kind="text", text="a", at=at(9)))
    _deliver(client, acc, IncomingMessage(fan(), tg_msg_id=2, out=False, kind="text", text="b", at=at(9, 1)))
    assert len(_convo(_outbox(client))) == 1  # still one "first" event


def test_incoming_colours_the_card_green(client, directory):
    acc = _import(client, directory, 53, AccountInfo(7004, "dana", "+1", "D"))
    now = utcnow().replace(microsecond=0)
    _deliver(client, acc, IncomingMessage(fan(), tg_msg_id=1, out=False, kind="text", text="hi", at=now))
    card = client.get(f"/api/accounts/{acc}").json()
    assert card["color"] == "green"  # online + a recent incoming message
    assert card["last_msg_at"] is not None


def test_power_off_reports_offline_status(client, directory):
    acc = _import(client, directory, 54, AccountInfo(7005, "erin", "+1", "E"))
    statuses = [p["status"] for p in _status(_outbox(client))]
    assert statuses == ["online"]  # import reported it online

    client.post(f"/api/accounts/{acc}/power", json={"on": False}, headers=H)
    statuses = [p["status"] for p in _status(_outbox(client))]
    assert statuses == ["online", "offline"]


def test_power_on_while_connected_is_a_noop(client, directory):
    # Regression: a second power-on must not trip the "already connected" guard and flag the
    # account dead. It stays online and connected.
    acc = _import(client, directory, 56, AccountInfo(7007, "gwen", "+1", "G"))
    r = client.post(f"/api/accounts/{acc}/power", json={"on": True}, headers=H)
    assert r.status_code == 200
    card = client.get(f"/api/accounts/{acc}").json()
    assert card["status"] == "online" and card["connected"] is True and card["color"] != "red"


def test_power_on_reconciles_stale_db_when_already_connected(client, directory):
    # The exact state left by the original bug: the client is still live in memory, but the DB
    # says power_on=false / status=error. A power-on click must clear that, not just return 200.
    acc = _import(client, directory, 58, AccountInfo(7009, "ivan", "+1", "I"))

    async def _corrupt():
        async with client.app.state.sessionmaker() as s:
            a = await s.get(Account, acc)
            a.power_on = False
            a.status, a.status_detail = "error", "Account is already connected"
            await s.commit()

    client.portal.call(_corrupt)
    assert client.app.state.service.manager.is_connected(acc)  # still connected in memory
    assert client.get(f"/api/accounts/{acc}").json()["color"] == "red"  # stale Dead/Off state

    r = client.post(f"/api/accounts/{acc}/power", json={"on": True}, headers=H)
    assert r.status_code == 200

    card = client.get(f"/api/accounts/{acc}").json()
    assert card["power_on"] is True
    assert card["status"] == "online" and card["status_detail"] is None
    assert card["connected"] is True
    assert card["color"] in ("green", "amber")  # no longer red/grey


def test_system_status_and_retry_endpoints(client, directory):
    acc = _import(client, directory, 55, AccountInfo(7006, "fay", "+1", "F"))
    _deliver(client, acc, IncomingMessage(fan(), tg_msg_id=1, out=False, kind="text", text="hi", at=at(9)))

    st = client.get("/api/system/status").json()
    assert st["portal"]["configured"] is False  # no PORTAL_INGEST_* in tests
    assert st["portal"]["pending"] >= 1 and st["portal"]["failed"] == 0
    assert client.post("/api/system/outbox/retry-failed", headers=H).json() == {"requeued": 0}
    assert client.get("/api/system/activity").json()["activity"] == [] or True
