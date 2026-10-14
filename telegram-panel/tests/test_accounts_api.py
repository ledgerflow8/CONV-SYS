import io
import json
import time
import zipfile

import pytest
from fastapi.testclient import TestClient

from panel.main import create_app
from panel.tg.client import AccountInfo, TgError
from tests.conftest import H, make_settings, set_password, speed_up_imports, PASSWORD
from tests.fake_tg import FakeAccount, FakeDirectory
from tests.make_session import key, pyrogram_session_bytes, string_session, telethon_session_bytes


@pytest.fixture
def directory():
    return FakeDirectory()


@pytest.fixture
def client(directory, settings, tmp_path):
    app = create_app(settings, dist=tmp_path / "no-dist", client_factory=directory.factory)
    with TestClient(app, base_url="https://panel.example.com") as c:
        set_password(c)
        speed_up_imports(c)
        c.post("/api/auth/login", json={"password": PASSWORD}, headers=H)
        yield c


def _account(session_string, user_id, username, phone="+15551230000", **kw):
    return string_session, FakeAccount(
        info=AccountInfo(user_id=user_id, username=username, phone=phone, first_name="T"), **kw
    )


def _upload(client, files):
    multipart = [("files", (name, io.BytesIO(data), "application/octet-stream")) for name, data in files]
    return client.post("/api/imports", files=multipart, headers=H)


def _wait_done(client, job_id, tries=100):
    for _ in range(tries):
        r = client.get(f"/api/imports/{job_id}").json()
        if r["done"]:
            return r
        time.sleep(0.05)
    raise AssertionError("import did not finish")


def test_import_one_working_session(client, directory):
    k = key(10)
    sess = string_session(k)
    directory.add(sess, FakeAccount(AccountInfo(user_id=111, username="alice", phone="+15550001111", first_name="A")))
    meta = json.dumps({"app_id": 1, "app_hash": "a" * 32}).encode()

    r = _upload(client, [("alice.session", telethon_session_bytes(k)), ("alice.json", meta)])
    assert r.status_code == 200
    job = _wait_done(client, r.json()["job_id"])
    assert job["results"][0]["result"] == "connected"
    assert job["results"][0]["username"] == "alice"

    accounts = client.get("/api/accounts").json()
    assert accounts["counts"]["all"] == 1
    card = accounts["accounts"][0]
    assert card["username"] == "alice" and card["status"] == "online" and card["connected"] is True
    # Online but no incoming message yet → amber.
    assert card["color"] == "amber"


def test_dead_session_reported_not_added(client, directory):
    k = key(11)
    sess = string_session(k)
    directory.add(sess, FakeAccount(AccountInfo(0, None, None, None), error=TgError("banned", "Account is banned by Telegram")))
    r = _upload(client, [("dead.session", telethon_session_bytes(k))])
    job = _wait_done(client, r.json()["job_id"])
    assert job["results"][0]["result"] == "dead"
    assert "banned" in job["results"][0]["detail"]
    assert client.get("/api/accounts").json()["counts"]["all"] == 0


def test_duplicate_in_same_batch_added_once(client, directory):
    k = key(12)
    sess = string_session(k)
    directory.add(sess, FakeAccount(AccountInfo(222, "bob", "+1", "B")))
    # Same auth key twice, different file names.
    r = _upload(client, [("bob.session", telethon_session_bytes(k)), ("bob-copy.session", telethon_session_bytes(k))])
    job = _wait_done(client, r.json()["job_id"])
    results = sorted(x["result"] for x in job["results"])
    assert results == ["connected", "duplicate"]
    assert client.get("/api/accounts").json()["counts"]["all"] == 1


def test_reupload_existing_is_duplicate_without_logout(client, directory):
    k = key(13)
    sess = string_session(k)
    directory.add(sess, FakeAccount(AccountInfo(333, "carol", "+1", "C")))
    _wait_done(client, _upload(client, [("c.session", telethon_session_bytes(k))]).json()["job_id"])
    # Re-upload the same session.
    job = _wait_done(client, _upload(client, [("c-again.session", telethon_session_bytes(k))]).json()["job_id"])
    assert job["results"][0]["result"] == "duplicate"
    assert directory.logged_out == []  # a duplicate is never logged out


def test_pyrogram_session_without_json_uses_panel_api(directory, tmp_path):
    settings = make_settings(tmp_path, tg_api_id=555, tg_api_hash="d" * 32)
    k = key(14)
    directory.add(string_session(k, dc_id=2), FakeAccount(AccountInfo(444, "dave", "+1", "D")))
    app = create_app(settings, dist=tmp_path / "x", client_factory=directory.factory)
    with TestClient(app, base_url="https://panel.example.com") as c:
        set_password(c)
        speed_up_imports(c)
        c.post("/api/auth/login", json={"password": PASSWORD}, headers=H)
        job = _wait_done(c, _upload(c, [("dave.session", pyrogram_session_bytes(k, dc_id=2))]).json()["job_id"])
        assert job["results"][0]["result"] == "connected"


def test_session_without_api_and_no_default_is_invalid(directory, tmp_path):
    # No panel default and a pyrogram file carrying no app_hash → can't connect.
    settings = make_settings(tmp_path, tg_api_id=None, tg_api_hash=None)
    k = key(15)
    directory.add(string_session(k, dc_id=2), FakeAccount(AccountInfo(555, "e", "+1", "E")))
    app = create_app(settings, dist=tmp_path / "x", client_factory=directory.factory)
    with TestClient(app, base_url="https://panel.example.com") as c:
        set_password(c)
        speed_up_imports(c)
        c.post("/api/auth/login", json={"password": PASSWORD}, headers=H)
        job = _wait_done(c, _upload(c, [("e.session", pyrogram_session_bytes(k, dc_id=2))]).json()["job_id"])
    assert job["results"][0]["result"] == "invalid"
    assert "api_id" in job["results"][0]["detail"]


def test_power_toggle_and_delete(client, directory):
    k = key(16)
    sess = string_session(k)
    directory.add(sess, FakeAccount(AccountInfo(666, "frank", "+1", "F")))
    _wait_done(client, _upload(client, [("f.session", telethon_session_bytes(k))]).json()["job_id"])
    acc_id = client.get("/api/accounts").json()["accounts"][0]["id"]

    # Power off → disconnected, grey.
    assert client.post(f"/api/accounts/{acc_id}/power", json={"on": False}, headers=H).status_code == 200
    card = client.get(f"/api/accounts/{acc_id}").json()
    assert card["connected"] is False and card["color"] == "grey"

    # Power back on.
    assert client.post(f"/api/accounts/{acc_id}/power", json={"on": True}, headers=H).status_code == 200
    assert client.get(f"/api/accounts/{acc_id}").json()["connected"] is True

    # AI needs a persona first.
    assert client.post(f"/api/accounts/{acc_id}/ai", json={"on": True}, headers=H).status_code == 409

    # Delete needs the right username; then logs out.
    assert client.request("DELETE", f"/api/accounts/{acc_id}", json={"confirm": "wrong"}, headers=H).status_code == 400
    assert client.request("DELETE", f"/api/accounts/{acc_id}", json={"confirm": "@frank"}, headers=H).status_code == 200
    assert directory.logged_out == [666]
    assert client.get("/api/accounts").json()["counts"]["all"] == 0


def test_accounts_reconnect_on_startup(directory, settings, tmp_path):
    # First run: import one account.
    k = key(17)
    sess = string_session(k)
    directory.add(sess, FakeAccount(AccountInfo(777, "gina", "+1", "G")))
    app1 = create_app(settings, dist=tmp_path / "x", client_factory=directory.factory)
    with TestClient(app1, base_url="https://panel.example.com") as c:
        set_password(c)
        speed_up_imports(c)
        c.post("/api/auth/login", json={"password": PASSWORD}, headers=H)
        _wait_done(c, _upload(c, [("g.session", telethon_session_bytes(k))]).json()["job_id"])

    # Second run: the powered-on account reconnects automatically.
    app2 = create_app(settings, dist=tmp_path / "x", client_factory=directory.factory)
    with TestClient(app2, base_url="https://panel.example.com") as c:
        speed_up_imports(c)
        c.post("/api/auth/login", json={"password": PASSWORD}, headers=H)
        card = c.get("/api/accounts").json()["accounts"][0]
        assert card["connected"] is True and card["status"] == "online"
        assert c.get("/healthz").json()["accounts_online"] == 1


def test_search_filters_by_username(client, directory):
    for i, name in enumerate(["anna", "annie", "zoe"]):
        k = key(20 + i)
        directory.add(string_session(k), FakeAccount(AccountInfo(900 + i, name, f"+1555000{i}", "x")))
        _wait_done(client, _upload(client, [(f"{name}.session", telethon_session_bytes(k))]).json()["job_id"])
    assert client.get("/api/accounts", params={"q": "ann"}).json()["counts"]["all"] == 2
    assert client.get("/api/accounts", params={"q": "zoe"}).json()["counts"]["all"] == 1


def test_import_requires_login(settings, tmp_path, directory):
    app = create_app(settings, dist=tmp_path / "x", client_factory=directory.factory)
    with TestClient(app, base_url="https://panel.example.com") as c:
        assert _upload(c, [("x.session", telethon_session_bytes(key(1)))]).status_code == 401
