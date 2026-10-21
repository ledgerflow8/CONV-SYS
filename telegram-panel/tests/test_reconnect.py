"""Resilience: a transient drop (network, timeout, or an update from a newer Telegram layer that
Telethon can't deserialize) must reconnect the account by itself with backoff, never park it Off
with the raw exception. Banned/revoked/frozen accounts are left alone."""

import asyncio
import io
import time

import pytest
from fastapi.testclient import TestClient
from telethon import errors

from panel.main import create_app
from panel.models import Account
from panel.tg.client import UNREADABLE_UPDATE_DETAIL, AccountInfo, TgError, classify
from tests.conftest import H, PASSWORD, set_password, speed_up_imports
from tests.fake_tg import FakeAccount, FakeDirectory
from tests.make_session import key, string_session, telethon_session_bytes


@pytest.fixture
def directory():
    return FakeDirectory()


@pytest.fixture
def client(directory, settings, tmp_path):
    app = create_app(settings, dist=tmp_path / "x", client_factory=directory.factory)
    with TestClient(app, base_url="https://panel.example.com") as c:
        set_password(c)
        speed_up_imports(c)
        # Make the reconnect backoff instant so tests don't wait real seconds.
        c.app.state.service.reconnect_delays = [0.0]
        c.app.state.service.reconnect_jitter = 0
        c.post("/api/auth/login", json={"password": PASSWORD}, headers=H)
        yield c


def run(client, factory):
    out = {}

    async def _r():
        out["v"] = await factory()

    client.portal.call(_r)
    return out.get("v")


def pump(client, secs=0.02):
    """Let the app's event loop run background tasks (watcher, reconnect loop) for a bit."""
    run(client, lambda: asyncio.sleep(secs))


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


def setup(c, directory, n, uid, username):
    return _import(c, directory, n, AccountInfo(uid, username, "+1", "A"))


def _acc(c, account_id):
    async def _q():
        async with c.app.state.sessionmaker() as s:
            return await s.get(Account, account_id)

    return run(c, _q)


def _wait(c, account_id, predicate, tries=80):
    for _ in range(tries):
        pump(c)
        if predicate():
            return True
    return False


# ── classification ────────────────────────────────────────────────────────────
def test_type_not_found_is_transient_with_a_human_message():
    err = classify(errors.TypeNotFoundError(0x12345678, b"rest"))
    assert err.status == "error"
    assert not err.dead and not err.leave_alone  # must reconnect, not park
    assert err.detail == UNREADABLE_UPDATE_DETAIL
    assert "Constructor" not in err.detail  # never the raw exception on the card


# ── auto-reconnect ──────────────────────────────────────────────────────────────
def test_transient_drop_reconnects(client, directory):
    svc = client.app.state.service
    acc_id = setup(client, directory, 70, 7001, "alpha")
    assert svc.manager.is_connected(acc_id)

    fake = svc.manager.get(acc_id)
    # An update from a newer layer that Telethon can't read — Telethon tears the connection down.
    run(client, lambda: fake.drop(TgError("error", UNREADABLE_UPDATE_DETAIL, "TypeNotFoundError")))

    assert _wait(client, acc_id, lambda: svc.manager.is_connected(acc_id) and _acc(client, acc_id).status == "online")
    a = _acc(client, acc_id)
    assert a.status == "online" and a.power_on is True
    assert acc_id not in svc._reconnect_tasks  # loop finished cleanly


def test_dead_drop_powers_off_and_does_not_reconnect(client, directory):
    svc = client.app.state.service
    acc_id = setup(client, directory, 71, 7002, "bravo")
    fake = svc.manager.get(acc_id)
    run(client, lambda: fake.drop(TgError("banned", "Account is banned by Telegram", "UserDeactivatedBanError")))

    assert _wait(client, acc_id, lambda: not svc.manager.is_connected(acc_id) and _acc(client, acc_id).status == "banned")
    a = _acc(client, acc_id)
    assert a.status == "banned" and a.power_on is False
    assert not svc.manager.is_connected(acc_id)
    assert acc_id not in svc._reconnect_tasks


def test_frozen_drop_is_left_alone(client, directory):
    svc = client.app.state.service
    acc_id = setup(client, directory, 72, 7003, "charlie")
    fake = svc.manager.get(acc_id)
    run(client, lambda: fake.drop(TgError("frozen", "Account is frozen or write-restricted by Telegram", "FrozenError")))

    assert _wait(client, acc_id, lambda: _acc(client, acc_id).status == "frozen")
    # Give any (unwanted) reconnect a chance to fire, then confirm it did not.
    for _ in range(10):
        pump(client)
    a = _acc(client, acc_id)
    assert a.status == "frozen" and a.power_on is True  # not powered off, not retried
    assert not svc.manager.is_connected(acc_id)
    assert acc_id not in svc._reconnect_tasks


def test_reconnect_retries_until_it_succeeds(client, directory):
    svc = client.app.state.service
    svc.reconnect_delays = [0.02]  # a little breathing room between the failing attempts
    acc_id = setup(client, directory, 73, 7004, "delta")
    fake_acc = directory.by_session[string_session(key(73))]

    # Make every reconnect attempt fail for now (e.g. network still down).
    fake_acc.error = TgError("error", "Couldn't reach Telegram", "OSError")
    fake = svc.manager.get(acc_id)
    run(client, lambda: fake.drop(TgError("error", UNREADABLE_UPDATE_DETAIL, "TypeNotFoundError")))

    # It keeps trying, staying in "connecting" with a clear message (never the raw exception).
    for _ in range(12):
        pump(client)
    assert not svc.manager.is_connected(acc_id)
    a = _acc(client, acc_id)
    assert a.status == "connecting"
    assert a.status_detail and "TypeNotFound" not in a.status_detail

    # Telegram recovers → the next attempt connects.
    fake_acc.error = None
    assert _wait(client, acc_id, lambda: svc.manager.is_connected(acc_id) and _acc(client, acc_id).status == "online")
    assert _acc(client, acc_id).status == "online"


def test_power_off_cancels_a_pending_reconnect(client, directory):
    svc = client.app.state.service
    svc.reconnect_delays = [0.05]
    acc_id = setup(client, directory, 74, 7005, "echo")
    fake_acc = directory.by_session[string_session(key(74))]
    fake_acc.error = TgError("error", "Couldn't reach Telegram", "OSError")  # keep retries failing
    fake = svc.manager.get(acc_id)
    run(client, lambda: fake.drop(TgError("error", UNREADABLE_UPDATE_DETAIL, "TypeNotFoundError")))
    assert _wait(client, acc_id, lambda: acc_id in svc._reconnect_tasks)

    # Turn the account off: the background retry must stop and stay stopped.
    assert client.post(f"/api/accounts/{acc_id}/power", json={"on": False}, headers=H).status_code == 200
    for _ in range(10):
        pump(client)
    a = _acc(client, acc_id)
    assert a.power_on is False and a.status == "offline"
    assert acc_id not in svc._reconnect_tasks
    assert not svc.manager.is_connected(acc_id)


# ── startup ─────────────────────────────────────────────────────────────────────
def test_startup_reconnects_offline_but_skips_frozen(client, directory):
    svc = client.app.state.service
    a1 = setup(client, directory, 75, 7006, "foxtrot")
    a2 = setup(client, directory, 76, 7007, "golf")
    run(client, lambda: svc.manager.disconnect(a1))
    run(client, lambda: svc.manager.disconnect(a2))

    async def _state():
        async with svc.sessionmaker() as s:
            acc1 = await s.get(Account, a1)
            acc1.status, acc1.power_on = "offline", True  # parked by an earlier drop
            acc2 = await s.get(Account, a2)
            acc2.status, acc2.power_on = "frozen", True
            await s.commit()

    run(client, _state)
    run(client, lambda: svc.connect_powered_on())

    assert svc.manager.is_connected(a1) and _acc(client, a1).status == "online"
    assert not svc.manager.is_connected(a2) and _acc(client, a2).status == "frozen"
