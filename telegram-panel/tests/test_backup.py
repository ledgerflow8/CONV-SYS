"""Encrypted, password-protected backup/restore of all accounts (client feedback 2026-10-29)."""

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select

from panel import backup
from panel.main import create_app
from panel.models import Account
from tests.conftest import H, PASSWORD, set_password, speed_up_imports
from tests.fake_tg import FakeDirectory
from tests.make_session import key, string_session
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


# ── the archive format (pure) ────────────────────────────────────────────────
def test_archive_roundtrip():
    accounts = [{"tg_user_id": 1, "session": "S1", "twofa": "pw"}, {"tg_user_id": 2, "session": "S2", "twofa": None}]
    blob = backup.export_archive(accounts, "a-good-password")
    assert blob.startswith(backup.MAGIC)
    assert backup.import_archive(blob, "a-good-password") == accounts


def test_archive_wrong_password():
    blob = backup.export_archive([{"session": "x"}], "right-password-1")
    with pytest.raises(backup.BackupError):
        backup.import_archive(blob, "wrong-password-1")


def test_archive_not_a_backup_file():
    with pytest.raises(backup.BackupError):
        backup.import_archive(b"just some bytes", "whatever")


# ── restore into a panel (service) ───────────────────────────────────────────
def test_restore_inserts_account_powered_off(client):
    sess = string_session(key(40))
    blob = backup.export_archive(
        [
            {
                "tg_user_id": 40040, "username": "restored", "phone": "+1555", "first_name": "R",
                "session": sess, "twofa": "2fapw", "proxy": None,
                "api_id": 111, "api_hash": "a" * 32, "power_on": True, "ai_on": True,
            }
        ],
        "backup-password-9",
    )
    res = run(client, lambda: client.app.state.service.restore_backup(blob, "backup-password-9"))
    assert res == {"restored": 1, "skipped": 0, "total": 1}

    async def _chk():
        async with client.app.state.sessionmaker() as s:
            a = await s.scalar(select(Account).where(Account.tg_user_id == 40040))
            crypto = client.app.state.service.crypto
            return a.username, a.power_on, crypto.decrypt(a.session_enc), crypto.decrypt(a.twofa_enc)

    username, power_on, dec_sess, dec_2fa = run(client, _chk)
    assert username == "restored"
    assert power_on is False  # restored offline; the owner connects them deliberately
    assert dec_sess == sess and dec_2fa == "2fapw"  # secrets re-encrypted under this panel's key


def test_restore_skips_accounts_already_present(client, directory):
    setup(client, directory, 41, 41041, "dup")  # import it first
    blob = run(client, lambda: client.app.state.service.export_backup("pass-word-xyz"))
    res = run(client, lambda: client.app.state.service.restore_backup(blob, "pass-word-xyz"))
    assert res["restored"] == 0 and res["skipped"] >= 1


# ── the HTTP routes ───────────────────────────────────────────────────────────
def test_export_then_import_over_http(client, directory):
    setup(client, directory, 42, 42042, "http")
    exp = client.post("/api/system/backup/export", json={"password": "http-pass-123"}, headers=H)
    assert exp.status_code == 200
    assert "attachment" in exp.headers["content-disposition"]
    blob = exp.content
    assert blob.startswith(backup.MAGIC)
    # Re-importing into the same panel: the account is already there, so it's skipped (idempotent).
    imp = client.post(
        "/api/system/backup/import",
        data={"password": "http-pass-123"},
        files={"file": ("backup.tgpbak", blob, "application/octet-stream")},
        headers=H,
    )
    assert imp.status_code == 200 and imp.json()["skipped"] >= 1

    bad = client.post(
        "/api/system/backup/import",
        data={"password": "wrong"},
        files={"file": ("backup.tgpbak", blob, "application/octet-stream")},
        headers=H,
    )
    assert bad.status_code == 400
