"""Editing an account's profile (name / bio / username / photo) over its live connection, and the
username-change → portal rename event."""

import io
import time

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select

from panel.main import create_app
from panel.models import Account, Activity, OutboxItem
from panel.tg.client import AccountInfo
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
        c.post("/api/auth/login", json={"password": PASSWORD}, headers=H)
        yield c


def run(client, factory):
    out = {}

    async def _r():
        out["v"] = await factory()

    client.portal.call(_r)
    return out.get("v")


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


def _acc(c, account_id):
    async def _q():
        async with c.app.state.sessionmaker() as s:
            return await s.get(Account, account_id)

    return run(c, _q)


def _outbox(c):
    async def _q():
        async with c.app.state.sessionmaker() as s:
            return [(o.kind, o.payload) for o in (await s.scalars(select(OutboxItem).order_by(OutboxItem.id))).all()]

    return run(c, _q)


def _activities(c):
    async def _q():
        async with c.app.state.sessionmaker() as s:
            return [a.kind for a in (await s.scalars(select(Activity))).all()]

    return run(c, _q)


def _client(c, account_id):
    return c.app.state.service.manager.get(account_id)


def setup(c, directory, n, uid, username, **fake_kw):
    return _import(c, directory, n, AccountInfo(uid, username, "+1", "A"), **fake_kw)


# ── prefill ──────────────────────────────────────────────────────────────────
def test_get_profile_reads_live_values(client, directory):
    acc = setup(client, directory, 60, 6001, "sophie", last_name="J", about="24, Miami")
    r = client.get(f"/api/accounts/{acc}/profile", headers=H).json()
    assert r == {"first_name": "A", "last_name": "J", "bio": "24, Miami", "username": "sophie"}


def test_get_profile_requires_connection(client, directory):
    acc = setup(client, directory, 61, 6002, "mia")
    run(client, lambda: client.app.state.service.manager.disconnect(acc))
    assert client.get(f"/api/accounts/{acc}/profile", headers=H).status_code == 409


# ── name + bio only (no rename) ───────────────────────────────────────────────
def test_edit_name_and_bio_no_username_change(client, directory):
    acc = setup(client, directory, 62, 6003, "lily")
    r = client.post(
        f"/api/accounts/{acc}/profile",
        data={"first_name": "Lily", "last_name": "Rose", "bio": "new bio", "username": "lily"},
        headers=H,
    )
    assert r.status_code == 200 and r.json()["username_changed"] is False
    assert _client(client, acc).profile_update == {"first_name": "Lily", "last_name": "Rose", "about": "new bio"}
    assert _acc(client, acc).first_name == "Lily"
    assert not [p for k, p in _outbox(client) if k == "account_status" and p.get("newUsername")]  # no rename
    assert "profile_edited" in _activities(client)


# ── username change → rename event ────────────────────────────────────────────
def test_username_change_updates_db_and_enqueues_rename(client, directory):
    acc = setup(client, directory, 63, 6004, "oldname")
    r = client.post(
        f"/api/accounts/{acc}/profile",
        data={"first_name": "A", "last_name": "", "bio": "", "username": "NewName"},
        headers=H,
    )
    assert r.status_code == 200 and r.json()["username_changed"] is True
    assert r.json()["card"]["username"] == "newname"
    assert _client(client, acc).username_set == "NewName"
    assert _acc(client, acc).username == "newname"
    renames = [p for k, p in _outbox(client) if k == "account_status" and p.get("newUsername")]
    assert len(renames) == 1
    assert renames[0] == {
        "tgUserId": "6004",
        "tgAccount": "newname",
        "oldUsername": "oldname",
        "newUsername": "newname",
        "at": renames[0]["at"],
    }


def test_username_taken_changes_nothing(client, directory):
    acc = setup(client, directory, 64, 6005, "keepme")
    directory.taken_usernames.add("grabbed")
    r = client.post(
        f"/api/accounts/{acc}/profile",
        data={"first_name": "A", "last_name": "", "bio": "", "username": "grabbed"},
        headers=H,
    )
    assert r.status_code == 409 and "taken" in r.json()["detail"].lower()
    assert _acc(client, acc).username == "keepme"  # unchanged
    assert not [p for k, p in _outbox(client) if k == "account_status" and p.get("newUsername")]


# ── availability check ─────────────────────────────────────────────────────────
def test_username_check_taken_invalid_and_free(client, directory):
    acc = setup(client, directory, 65, 6006, "zoe")
    directory.taken_usernames.add("grabbed")
    taken = client.post(f"/api/accounts/{acc}/username-check", json={"username": "grabbed"}, headers=H).json()
    invalid = client.post(f"/api/accounts/{acc}/username-check", json={"username": "no"}, headers=H).json()
    free = client.post(f"/api/accounts/{acc}/username-check", json={"username": "brandnew99"}, headers=H).json()
    assert taken == {"available": False, "reason": "taken"}
    assert invalid == {"available": False, "reason": "invalid"}
    assert free == {"available": True, "reason": None}


def test_username_check_floodwait_is_a_clear_error(client, directory):
    acc = setup(client, directory, 66, 6007, "ivy", username_floodwait=600)
    r = client.post(f"/api/accounts/{acc}/username-check", json={"username": "brandnew99"}, headers=H)
    assert r.status_code == 429 and "min" in r.json()["detail"]


# ── photo ──────────────────────────────────────────────────────────────────────
def test_remove_photo_clears_avatar(client, directory):
    acc = setup(client, directory, 67, 6008, "nora")
    run(client, lambda: client.app.state.service.refresh_avatar(acc))  # give it an avatar first
    assert _acc(client, acc).avatar_path is not None
    r = client.post(
        f"/api/accounts/{acc}/profile",
        data={"first_name": "A", "last_name": "", "bio": "", "username": "nora", "remove_photo": "true"},
        headers=H,
    )
    assert r.status_code == 200
    assert _client(client, acc).photo_deleted is True
    assert _acc(client, acc).avatar_path is None


def test_upload_photo_sets_it_and_refreshes_card(client, directory):
    acc = setup(client, directory, 68, 6009, "gina", has_avatar=False)
    files = {"photo": ("p.jpg", io.BytesIO(b"\xff\xd8\xff\xe0jpeg-bytes"), "image/jpeg")}
    r = client.post(
        f"/api/accounts/{acc}/profile",
        data={"first_name": "A", "last_name": "", "bio": "", "username": "gina"},
        files=files,
        headers=H,
    )
    assert r.status_code == 200
    assert _client(client, acc).photo_set is not None
    assert r.json()["card"]["has_avatar"] is True


def test_reject_non_image_photo(client, directory):
    acc = setup(client, directory, 69, 6010, "pia")
    files = {"photo": ("x.gif", io.BytesIO(b"GIF89a"), "image/gif")}
    r = client.post(
        f"/api/accounts/{acc}/profile",
        data={"first_name": "A", "last_name": "", "bio": "", "username": "pia"},
        files=files,
        headers=H,
    )
    assert r.status_code == 400 and ("JPG" in r.json()["detail"] or "PNG" in r.json()["detail"])
