"""Client feedback 2026-10-17: preset selection, per-account stats, frozen status, and portal
pool auto-sync (register on import, retire on delete)."""

import io
import time

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select

from panel.health import health_color
from panel.main import create_app
from panel.models import Account, OutboxItem, Profile, utcnow
from panel.tg.client import AccountInfo, IncomingMessage, PeerInfo, classify
from tests.conftest import H, PASSWORD, set_password, speed_up_imports
from tests.fake_tg import FakeAccount, FakeDirectory
from tests.make_session import key, string_session, telethon_session_bytes


# ── pure: frozen classification + health colour ──────────────────────────────
def test_frozen_classification_from_error():
    assert classify(Exception("FROZEN_METHOD_INVALID: account frozen")).status == "frozen"


def test_frozen_health_colour_is_its_own():
    assert health_color(Account(status="frozen", power_on=True), 12) == "purple"
    assert health_color(Account(status="banned", power_on=True), 12) == "red"


# ── HTTP + DB harness ─────────────────────────────────────────────────────────
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


def run(client, factory):
    out = {}

    async def _r():
        out["v"] = await factory()

    client.portal.call(_r)
    return out.get("v")


def _import(c, directory, n, info, **fake_kw):
    directory.add(string_session(key(n)), FakeAccount(info, **fake_kw))
    files = [("files", (f"{info.username or n}.session", io.BytesIO(telethon_session_bytes(key(n))), "application/octet-stream"))]
    job = c.post("/api/imports", files=files, headers=H).json()["job_id"]
    for _ in range(100):
        if c.get(f"/api/imports/{job}").json()["done"]:
            break
        time.sleep(0.02)
    return c.get("/api/accounts").json()["accounts"][0]["id"]


def _outbox(c):
    async def _q():
        async with c.app.state.sessionmaker() as s:
            return [(o.kind, o.payload) for o in (await s.scalars(select(OutboxItem).order_by(OutboxItem.id))).all()]

    return run(c, _q)


def _acc(c, account_id):
    async def _q():
        async with c.app.state.sessionmaker() as s:
            return await s.get(Account, account_id)

    return run(c, _q)


# ── item 1: preset selection ─────────────────────────────────────────────────
def test_set_preset_creates_profile_and_enables_ai(client, directory):
    acc = _import(client, directory, 40, AccountInfo(4001, "sel", "+1", "A"))
    r = client.post(f"/api/accounts/{acc}/preset", json={"model_id": 3073, "preset_id": 6823, "name": "Sophie"}, headers=H)
    assert r.status_code == 200
    a = _acc(client, acc)
    assert a.ai_on is True and a.profile_id is not None and a.profile_overrides == {}

    async def _prof():
        async with client.app.state.sessionmaker() as s:
            return await s.get(Profile, a.profile_id)

    prof = run(client, _prof)
    assert (prof.capital_model_id, prof.capital_preset_id, prof.name) == (3073, 6823, "Sophie")


def test_set_preset_reuses_an_existing_profile(client, directory):
    acc1 = _import(client, directory, 41, AccountInfo(4002, "one", "+1", "A"))
    acc2 = _import(client, directory, 42, AccountInfo(4003, "two", "+1", "A"))
    client.post(f"/api/accounts/{acc1}/preset", json={"model_id": 43, "preset_id": 88}, headers=H)
    client.post(f"/api/accounts/{acc2}/preset", json={"model_id": 43, "preset_id": 88}, headers=H)
    assert _acc(client, acc1).profile_id == _acc(client, acc2).profile_id  # shared thin profile


# ── item 2: stats ─────────────────────────────────────────────────────────────
def test_account_stats_counts_chats_and_ai_replies(client, directory):
    acc = _import(client, directory, 43, AccountInfo(4004, "stat", "+1", "A"))
    fan = PeerInfo(peer_id="555", username="f", name="F", phone="+1")
    run(client, lambda: client.app.state.service.manager.get(acc).deliver(
        IncomingMessage(fan, tg_msg_id=1, out=False, kind="text", text="hi", at=utcnow())
    ))
    run(client, lambda: client.app.state.service.record_ai_message(acc, "555", 9001, "text", "hey", utcnow()))

    stats = client.get(f"/api/accounts/{acc}/stats", headers=H).json()
    assert stats["all"]["new_chats"] >= 1
    assert stats["all"]["ai_replies"] >= 1
    assert "last_activity" in stats and set(stats) >= {"today", "week", "all"}


# ── item 4: portal pool auto-sync ─────────────────────────────────────────────
def test_import_registers_account_in_portal(client, directory):
    _import(client, directory, 44, AccountInfo(4005, "reg", "+15551234567", "A"))
    reg = [p for k, p in _outbox(client) if k == "account_status" and p.get("action") == "register"]
    assert len(reg) == 1
    assert reg[0]["tgUserId"] == "4005"
    assert reg[0]["username"] == "reg"
    assert reg[0]["link"] == "https://t.me/reg"


def test_register_has_null_link_when_no_username(client, directory):
    _import(client, directory, 45, AccountInfo(4006, None, "+1", "A"))
    reg = [p for k, p in _outbox(client) if k == "account_status" and p.get("action") == "register"]
    assert reg and reg[0]["username"] is None and reg[0]["link"] is None


def test_delete_retires_account_in_portal(client, directory):
    acc = _import(client, directory, 46, AccountInfo(4007, "gone", "+1", "A"))
    r = client.request("DELETE", f"/api/accounts/{acc}", json={"confirm": "gone"}, headers=H)
    assert r.status_code == 200
    ret = [p for k, p in _outbox(client) if k == "account_status" and p.get("action") == "retire"]
    assert ret and ret[0]["tgUserId"] == "4007"
