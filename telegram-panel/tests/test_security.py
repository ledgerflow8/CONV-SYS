"""Account security: terminate other Telegram sessions and set/change the 2FA password, per account
and in bulk (client feedback 2026-10-29)."""

from datetime import datetime, timezone

import pytest
from fastapi.testclient import TestClient

from panel.main import create_app
from panel.models import Account
from tests.conftest import H, PASSWORD, set_password, speed_up_imports
from tests.fake_tg import FakeDirectory
from tests.test_ai import run, setup


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


def _fake(client, acc):
    return client.app.state.service.manager.get(acc)


def _crypto(client):
    return client.app.state.service.crypto


def _seed_twofa(client, acc, value):
    async def _s():
        async with client.app.state.sessionmaker() as s:
            a = await s.get(Account, acc)
            a.twofa_enc = _crypto(client).encrypt(value)
            await s.commit()

    run(client, _s)


# ── terminate other sessions ──────────────────────────────────────────────────
def test_reset_sessions_ok(client, directory):
    acc = setup(client, directory, 60, 6000, "a")
    r = client.post(f"/api/accounts/{acc}/security/reset-sessions", headers=H)
    assert r.status_code == 200 and r.json()["ok"] is True
    assert _fake(client, acc).sessions_reset == 1


def test_reset_sessions_too_fresh_gives_available_time(client, directory):
    when = datetime(2026, 11, 2, 15, 30, tzinfo=timezone.utc)
    acc = setup(client, directory, 61, 6001, "b", reset_too_fresh_until=when)
    r = client.post(f"/api/accounts/{acc}/security/reset-sessions", headers=H)
    assert r.status_code == 409
    assert "24h" in r.json()["detail"] and "Available after" in r.json()["detail"]
    assert _fake(client, acc).sessions_reset == 0


# ── 2FA ───────────────────────────────────────────────────────────────────────
def test_set_2fa_new_and_store_encrypted(client, directory):
    acc = setup(client, directory, 62, 6002, "c")
    r = client.post(f"/api/accounts/{acc}/security/2fa", json={"new_password": "s3cret-pw"}, headers=H)
    assert r.status_code == 200
    assert r.json()["password"] == "s3cret-pw"  # shown once so the owner can copy it
    assert _fake(client, acc).twofa_set_to == "s3cret-pw"

    async def _stored():
        async with client.app.state.sessionmaker() as s:
            a = await s.get(Account, acc)
            return _crypto(client).decrypt(a.twofa_enc)

    assert run(client, _stored) == "s3cret-pw"  # stored encrypted, decrypts back


def test_change_2fa_uses_the_stored_current(client, directory):
    acc = setup(client, directory, 63, 6003, "d", twofa="oldpw")
    _seed_twofa(client, acc, "oldpw")  # as the import would, from the supplier .json
    r = client.post(f"/api/accounts/{acc}/security/2fa", json={"new_password": "newpw123"}, headers=H)
    assert r.status_code == 200
    assert _fake(client, acc).twofa_set_to == "newpw123"


def test_change_2fa_without_the_current_password_fails(client, directory):
    acc = setup(client, directory, 64, 6004, "e", twofa="server-set")  # Telegram has 2FA; we don't
    r = client.post(f"/api/accounts/{acc}/security/2fa", json={"new_password": "newpw123"}, headers=H)
    assert r.status_code == 409


# ── bulk ────────────────────────────────────────────────────────────────────
def test_bulk_reset_sessions_reports_per_account(client, directory):
    a1 = setup(client, directory, 65, 6005, "f")
    a2 = setup(client, directory, 66, 6006, "g")
    r = client.post("/api/accounts/bulk/reset-sessions", json={"account_ids": [a1, a2, 999999]}, headers=H)
    assert r.status_code == 200
    by_id = {x["account_id"]: x for x in r.json()["results"]}
    assert by_id[a1]["ok"] and by_id[a2]["ok"]
    assert by_id[999999]["ok"] is False and "No such account" in by_id[999999]["error"]
    assert _fake(client, a1).sessions_reset == 1 and _fake(client, a2).sessions_reset == 1


def test_bulk_set_2fa(client, directory):
    a1 = setup(client, directory, 67, 6007, "h")
    a2 = setup(client, directory, 68, 6008, "i")
    r = client.post("/api/accounts/bulk/2fa", json={"account_ids": [a1, a2], "new_password": "bulk-pw-9"}, headers=H)
    assert r.status_code == 200
    assert all(x["ok"] for x in r.json()["results"])
    assert _fake(client, a1).twofa_set_to == "bulk-pw-9" and _fake(client, a2).twofa_set_to == "bulk-pw-9"
