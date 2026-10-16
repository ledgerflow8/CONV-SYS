"""Step 3 HTTP surface: catalog, personas, persona assignment, chat reset and settings."""

import io
import time
from datetime import datetime, timezone

import pytest
from fastapi.testclient import TestClient

from panel.main import create_app
from panel.models import Chat
from panel.tg.client import AccountInfo, IncomingMessage, PeerInfo
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


def _import(c, directory, n, info):
    k = key(n)
    directory.add(string_session(k), FakeAccount(info))
    files = [("files", (f"{info.username}.session", io.BytesIO(telethon_session_bytes(k)), "application/octet-stream"))]
    job = c.post("/api/imports", files=files, headers=H).json()["job_id"]
    for _ in range(100):
        if c.get(f"/api/imports/{job}").json()["done"]:
            break
        time.sleep(0.02)
    return c.get("/api/accounts").json()["accounts"][0]["id"]


def test_catalog_reports_unconfigured_without_a_license_key(client):
    r = client.get("/api/capital/catalog")
    assert r.status_code == 200 and r.json() == {"configured": False, "models": [], "presets": []}


def test_persona_crud_and_delete_guard(client, directory):
    acc = _import(client, directory, 90, AccountInfo(9000, "alice", "+1", "A"))

    created = client.post(
        "/api/profiles",
        json={"name": "Lily", "capital_model_id": 43, "capital_preset_id": 88, "overrides": {"city": "Miami", "bogusKey": "x"}},
        headers=H,
    ).json()
    pid = created["id"]
    assert created["overrides"] == {"city": "Miami"}  # unknown keys dropped

    assert any(p["id"] == pid for p in client.get("/api/profiles").json()["profiles"])

    client.patch(f"/api/profiles/{pid}", json={"name": "Lily2", "capital_model_id": 43, "capital_preset_id": 89, "overrides": {}}, headers=H)

    # Assign it, then deleting must be refused while an account uses it.
    client.patch(f"/api/accounts/{acc}", json={"profile_id": pid}, headers=H)
    assert client.get(f"/api/accounts/{acc}").json()["profile_name"] == "Lily2"
    assert client.delete(f"/api/profiles/{pid}", headers=H).status_code == 409

    # Unassign, then delete succeeds.
    client.patch(f"/api/accounts/{acc}", json={"profile_id": None}, headers=H)
    assert client.get(f"/api/accounts/{acc}").json()["ai_on"] is False  # dropping the persona switches AI off
    assert client.delete(f"/api/profiles/{pid}", headers=H).status_code == 200


def test_ai_toggle_needs_a_persona(client, directory):
    acc = _import(client, directory, 91, AccountInfo(9100, "bob", "+1", "B"))
    assert client.post(f"/api/accounts/{acc}/ai", json={"on": True}, headers=H).status_code == 409
    pid = client.post("/api/profiles", json={"name": "P", "capital_model_id": 1, "capital_preset_id": 2}, headers=H).json()["id"]
    client.patch(f"/api/accounts/{acc}", json={"profile_id": pid}, headers=H)
    assert client.post(f"/api/accounts/{acc}/ai", json={"on": True}, headers=H).status_code == 200


def test_chat_reset_and_underage_is_permanent(client, directory):
    acc = _import(client, directory, 92, AccountInfo(9200, "carol", "+1", "C"))
    peer = PeerInfo(peer_id="555", username="f", name="F", phone=None)

    async def _deliver():
        await client.app.state.service.manager.get(acc).deliver(
            IncomingMessage(peer, tg_msg_id=1, out=False, kind="text", text="hi", at=datetime(2026, 10, 7, 9, tzinfo=timezone.utc))
        )

    client.portal.call(_deliver)

    def set_state(state, reason):
        async def _s():
            async with client.app.state.sessionmaker() as s:
                from sqlalchemy import select

                chat = await s.scalar(select(Chat).where(Chat.account_id == acc, Chat.peer_id == "555"))
                chat.ai_state, chat.ai_state_reason = state, reason
                await s.commit()

        client.portal.call(_s)

    set_state("filtered", "ignored")
    assert client.post(f"/api/accounts/{acc}/chats/555/reset", headers=H).status_code == 200
    assert client.get(f"/api/accounts/{acc}").json()["chats"][0]["ai_state"] == "active"

    set_state("stopped", "underage")
    assert client.post(f"/api/accounts/{acc}/chats/555/reset", headers=H).status_code == 409


def test_settings_roundtrip_and_validation(client):
    assert client.get("/api/system/settings").json()["settings"]["ai_global_on"] is True
    out = client.patch("/api/system/settings", json={"ai_global_on": False, "ai_debounce_sec": 3}, headers=H).json()
    assert out["settings"]["ai_global_on"] is False and out["settings"]["ai_debounce_sec"] == 3
    assert client.patch("/api/system/settings", json={"quiet_after_hours": 999}, headers=H).status_code == 400


def test_status_has_ai_block(client):
    ai = client.get("/api/system/status").json()["ai"]
    assert ai == {"configured": False, "global_on": True, "credit_over_until": None, "last_error": None}
