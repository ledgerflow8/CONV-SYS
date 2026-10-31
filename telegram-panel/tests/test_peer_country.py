"""Tier-1 filter using Telegram's PeerSettings phone-country for hidden numbers (client feedback 2026-11-01)."""

from datetime import datetime, timezone

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select

from panel.db import set_setting
from panel.main import create_app
from panel.models import OutboxItem
from panel.tg.client import IncomingMessage, PeerInfo
from tests.conftest import H, PASSWORD, make_settings, set_password, speed_up_imports
from tests.fake_tg import FakeDirectory
from tests.test_ai import FakeCapital, cresp, deliver, get_chat, run, run_turn, set_capital, setup


def at(h, m=0):
    return datetime(2026, 11, 1, h, m, tzinfo=timezone.utc)


def hidden_fan():
    return PeerInfo(peer_id="555", username="fan1", name="Fan", phone=None)  # number hidden


@pytest.fixture
def directory():
    return FakeDirectory()


@pytest.fixture
def client(directory, tmp_path):
    app = create_app(make_settings(tmp_path, phone_filter_enabled=True), dist=tmp_path / "x", client_factory=directory.factory)
    with TestClient(app, base_url="https://panel.example.com") as c:
        set_password(c)
        speed_up_imports(c)
        c.post("/api/auth/login", json={"password": PASSWORD}, headers=H)
        yield c


def _set(client, **kw):
    async def _s():
        async with client.app.state.sessionmaker() as s:
            for k, v in kw.items():
                await set_setting(s, k, v)
            await s.commit()

    run(client, _s)


def _convos(client):
    async def _q():
        async with client.app.state.sessionmaker() as s:
            rows = (await s.scalars(select(OutboxItem).where(OutboxItem.kind == "convo"))).all()
            return [dict(r.payload) for r in rows]

    return run(client, _q)


def _hi(client, acc):
    deliver(client, acc, IncomingMessage(hidden_fan(), tg_msg_id=1, out=False, kind="text", text="hi", at=at(9)))
    run_turn(client, acc)


def test_get_peer_country_reads_peersettings(client, directory):
    acc = setup(client, directory, 70, 7000, "a", peer_countries={"555": "US"})
    assert run(client, lambda: client.app.state.service.manager.get(acc).get_peer_country(555)) == "US"


def test_hidden_phone_non_tier1_peersettings_rejects(client, directory):
    acc = setup(client, directory, 71, 7001, "b", peer_countries={"555": "JM"})  # Jamaica: not Tier 1
    _set(client, tier1_only=True)
    set_capital(client, FakeCapital(cresp(texts=["hi"])))
    _hi(client, acc)
    assert client.app.state.ai.capital.calls == []  # not sent to Capitalbot
    chat = get_chat(client, acc)
    assert (chat.ai_state, chat.ai_state_reason) == ("filtered", "non_tier1")


def test_hidden_phone_tier1_peersettings_allows_and_reports(client, directory):
    acc = setup(client, directory, 72, 7002, "c", peer_countries={"555": "US"})
    _set(client, tier1_only=True)
    set_capital(client, FakeCapital(cresp(texts=["hey"], conversation_id=1)))
    _hi(client, acc)
    assert len(client.app.state.ai.capital.calls) == 1  # allowed through
    reported = [p for p in _convos(client) if p.get("phoneCountry")]
    assert reported and reported[0]["phoneCountry"] == "US"  # sent to the portal


def test_country_source_in_chat_list_and_activity(client, directory):
    acc = setup(client, directory, 73, 7003, "d", peer_countries={"555": "US"})
    _set(client, tier1_only=True)
    set_capital(client, FakeCapital(cresp(texts=["hey"], conversation_id=1)))
    _hi(client, acc)
    card = client.get(f"/api/accounts/{acc}", headers=H).json()
    chat = next(c for c in card["chats"] if c["peer_id"] == "555")
    assert chat["country"] == "US" and chat["country_source"] == "tg_phone_country"
    acts = client.get("/api/system/activity", headers=H).json()["activity"]
    assert any(a["kind"] == "country_source" and "Telegram phone-country" in a["message"] for a in acts)
