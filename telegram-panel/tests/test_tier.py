"""Our own Tier-1 country pre-filter: the pure decision, the phone→country resolver, and the AI gate
that skips Capitalbot for non-Tier-1 fans (client feedback 2026-10-30)."""

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select

from panel import tier
from panel.db import set_setting
from panel.main import create_app
from panel.models import Chat
from panel.tier import ALLOW, REJECT_NON_TIER1, SKIP, tier_decision
from panel.tg.client import IncomingMessage, PeerInfo
from tests.conftest import H, PASSWORD, make_settings, set_password, speed_up_imports
from tests.fake_tg import FakeDirectory
from tests.test_ai import FakeCapital, cresp, deliver, get_chat, run, run_turn, set_capital, setup


def at(h, m=0):
    from datetime import datetime, timezone

    return datetime(2026, 10, 30, h, m, tzinfo=timezone.utc)


# ── the pure decision ─────────────────────────────────────────────────────────
def test_decision_disabled_always_allows():
    assert tier_decision("JM", enabled=False, hidden_mode="skip", tier1=["US"]) == ALLOW


def test_decision_visible_phone():
    assert tier_decision("US", enabled=True, hidden_mode="ai", tier1=tier.DEFAULT_TIER1) == ALLOW
    assert tier_decision("JM", enabled=True, hidden_mode="ai", tier1=tier.DEFAULT_TIER1) == REJECT_NON_TIER1


def test_decision_hidden_phone_follows_setting():
    assert tier_decision(None, enabled=True, hidden_mode="ai", tier1=tier.DEFAULT_TIER1) == ALLOW
    assert tier_decision(None, enabled=True, hidden_mode="skip", tier1=tier.DEFAULT_TIER1) == SKIP


def test_country_for_phone():
    pytest.importorskip("phonenumbers")
    assert tier.country_for_phone("+1 415 555 0132") == "US"
    assert tier.country_for_phone("+1 876 555 0132") == "JM"  # Jamaica, +1 but not Tier 1
    assert tier.country_for_phone("+49 170 1234567") == "DE"
    assert tier.country_for_phone(None) is None


# ── the AI gate ───────────────────────────────────────────────────────────────
@pytest.fixture
def directory():
    return FakeDirectory()


def _app(directory, tmp_path, *, flag):
    app = create_app(make_settings(tmp_path, phone_filter_enabled=flag), dist=tmp_path / "x", client_factory=directory.factory)
    c = TestClient(app, base_url="https://panel.example.com")
    c.__enter__()
    set_password(c)
    speed_up_imports(c)
    c.post("/api/auth/login", json={"password": PASSWORD}, headers=H)
    return c


@pytest.fixture
def client(directory, tmp_path):
    c = _app(directory, tmp_path, flag=True)  # feature flag ON, so the gate actually runs
    yield c
    c.__exit__(None, None, None)


def _set(client, **kw):
    async def _s():
        async with client.app.state.sessionmaker() as s:
            for k, v in kw.items():
                await set_setting(s, k, v)
            await s.commit()

    run(client, _s)


def _fan(phone):
    return PeerInfo(peer_id="555", username="fan1", name="Fan", phone=phone)


def test_visible_non_tier1_phone_skips_capitalbot(client, directory, monkeypatch):
    monkeypatch.setattr(tier, "country_for_phone", lambda p: "JM" if p else None)
    acc = setup(client, directory, 95, 9500, "ta")
    _set(client, tier1_only=True)
    set_capital(client, FakeCapital(cresp(texts=["hi"])))
    deliver(client, acc, IncomingMessage(_fan("+18765550132"), tg_msg_id=1, out=False, kind="text", text="hi", at=at(9)))
    run_turn(client, acc)
    assert client.app.state.ai.capital.calls == []  # Capitalbot never called — credits saved
    chat = get_chat(client, acc)
    assert (chat.ai_state, chat.ai_state_reason) == ("filtered", "non_tier1")


def test_visible_tier1_phone_is_allowed(client, directory, monkeypatch):
    monkeypatch.setattr(tier, "country_for_phone", lambda p: "US" if p else None)
    acc = setup(client, directory, 96, 9600, "tb")
    _set(client, tier1_only=True)
    set_capital(client, FakeCapital(cresp(texts=["hey"], conversation_id=1)))
    deliver(client, acc, IncomingMessage(_fan("+14155550132"), tg_msg_id=1, out=False, kind="text", text="hi", at=at(9)))
    run_turn(client, acc)
    assert len(client.app.state.ai.capital.calls) == 1


def test_hidden_phone_dont_reply_skips(client, directory):
    acc = setup(client, directory, 97, 9700, "tc")
    _set(client, tier1_only=True, tier1_hidden="skip")
    set_capital(client, FakeCapital(cresp(texts=["hi"])))
    deliver(client, acc, IncomingMessage(_fan(None), tg_msg_id=1, out=False, kind="text", text="hi", at=at(9)))
    run_turn(client, acc)
    assert client.app.state.ai.capital.calls == []


def test_hidden_phone_default_lets_capitalbot_decide(client, directory):
    acc = setup(client, directory, 98, 9800, "td")
    _set(client, tier1_only=True)  # hidden default = "ai"
    set_capital(client, FakeCapital(cresp(texts=["hey"], conversation_id=1)))
    deliver(client, acc, IncomingMessage(_fan(None), tg_msg_id=1, out=False, kind="text", text="hi", at=at(9)))
    run_turn(client, acc)
    assert len(client.app.state.ai.capital.calls) == 1


def test_feature_flag_off_disables_filtering_and_hides_settings(directory, tmp_path, monkeypatch):
    monkeypatch.setattr(tier, "country_for_phone", lambda p: "JM" if p else None)
    c = _app(directory, tmp_path, flag=False)  # PHONE_FILTER_ENABLED=false
    try:
        assert c.get("/api/system/tier", headers=H).json()["feature_enabled"] is False  # UI hides itself
        acc = setup(c, directory, 99, 9999, "off")
        _set(c, tier1_only=True)  # set, but the flag is off, so it must have no effect
        set_capital(c, FakeCapital(cresp(texts=["hi"], conversation_id=1)))
        deliver(c, acc, IncomingMessage(_fan("+18765550132"), tg_msg_id=1, out=False, kind="text", text="hi", at=at(9)))
        run_turn(c, acc)
        assert len(c.app.state.ai.capital.calls) == 1  # Capitalbot still called — no filtering while off
    finally:
        c.__exit__(None, None, None)
