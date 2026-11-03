"""Tier-1 filter using Telegram's PeerSettings phone-country for hidden numbers (client feedback 2026-11-01)."""

from datetime import datetime, timezone

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select

from panel.db import set_setting
from panel.main import create_app
from panel.models import Account, Chat, OutboxItem
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


def _profile_id(client, acc):
    async def _q():
        async with client.app.state.sessionmaker() as s:
            a = await s.get(Account, acc)
            return a.profile_id

    return run(client, _q)


def _set_raw(client, key, value):
    async def _s():
        async with client.app.state.sessionmaker() as s:
            await set_setting(s, key, value)
            await s.commit()

    run(client, _s)


def _spin(client, seconds=0.05):
    async def _s():
        import asyncio

        await asyncio.sleep(seconds)

    run(client, _s)


def _activity_kinds(client):
    return [a["kind"] for a in client.get("/api/system/activity", headers=H).json()["activity"]]


# ── item 1: a confirmed Tier-1 country switches to the persona's no-filter preset ──
def test_confirmed_tier1_uses_the_no_filter_preset(client, directory):
    acc = setup(client, directory, 74, 7004, "nf", peer_countries={"555": "US"})
    _set_raw(client, f"nofilter_preset:{_profile_id(client, acc)}", 999)
    fake = FakeCapital(cresp(texts=["hey"], conversation_id=1))
    set_capital(client, fake)
    _hi(client, acc)
    assert fake.calls and fake.calls[0]["preset_id"] == 999  # confirmed Tier-1 → no-filter preset


def test_unknown_country_uses_the_normal_preset(client, directory):
    acc = setup(client, directory, 75, 7005, "nf2")  # phone hidden, no PeerSettings country
    _set_raw(client, f"nofilter_preset:{_profile_id(client, acc)}", 999)
    fake = FakeCapital(cresp(texts=["hey"], conversation_id=1))
    set_capital(client, fake)
    _hi(client, acc)
    assert fake.calls and fake.calls[0]["preset_id"] == 88  # unknown → the normal (tier-filter-on) preset


# ── item 3: trust OUR country over Capitalbot's tier guess when reporting ──
def test_tierfiltered_with_reliable_tier1_is_not_rejected(client, directory):
    acc = setup(client, directory, 76, 7006, "t1", peer_countries={"555": "US"})  # no no-filter preset set
    set_capital(client, FakeCapital(cresp(tierFiltered=True)))
    _hi(client, acc)
    assert all(p.get("tier") != "NON_T1" for p in _convos(client))  # our US beats Capitalbot's guess
    assert "tier_override" in _activity_kinds(client)  # flagged so a no-filter preset can be set


def test_tierfiltered_with_unknown_country_still_rejects(client, directory):
    acc = setup(client, directory, 77, 7007, "unk")  # hidden, no country of our own
    set_capital(client, FakeCapital(cresp(tierFiltered=True)))
    _hi(client, acc)
    assert any(p.get("tier") == "NON_T1" for p in _convos(client))  # AI verdict is the only signal


# ── item 4: the reply watchdog re-attempts an unanswered active chat ──
def _age_unanswered(client, acc):
    async def _u():
        async with client.app.state.sessionmaker() as s:
            chat = await s.scalar(select(Chat).where(Chat.account_id == acc, Chat.peer_id == "555"))
            chat.last_in_at = datetime(2026, 11, 1, 9, tzinfo=timezone.utc)  # ~2 days ago: in [10 min, 7 days]
            chat.last_out_at = None
            chat.ai_state = "active"
            await s.commit()

    run(client, _u)


def test_watchdog_reattempts_unanswered_active_chat(client, directory):
    acc = setup(client, directory, 78, 7008, "wd", peer_countries={"555": "US"})
    fake = FakeCapital(cresp(texts=["sorry, here now"], conversation_id=1))
    set_capital(client, fake)
    deliver(client, acc, IncomingMessage(hidden_fan(), tg_msg_id=1, out=False, kind="text", text="hey?", at=at(9)))
    _age_unanswered(client, acc)
    run(client, lambda: client.app.state.ai._watchdog_scan())
    assert len(fake.calls) == 1  # the stranded fan was re-attempted


def test_watchdog_skips_already_answered_chat(client, directory):
    acc = setup(client, directory, 80, 7010, "wd2", peer_countries={"555": "US"})
    fake = FakeCapital(cresp(texts=["x"], conversation_id=1))
    set_capital(client, fake)
    deliver(client, acc, IncomingMessage(hidden_fan(), tg_msg_id=1, out=False, kind="text", text="hey?", at=at(9)))

    async def _answered():
        async with client.app.state.sessionmaker() as s:
            chat = await s.scalar(select(Chat).where(Chat.account_id == acc, Chat.peer_id == "555"))
            chat.last_in_at = datetime(2026, 11, 1, 9, 0, tzinfo=timezone.utc)
            chat.last_out_at = datetime(2026, 11, 1, 9, 5, tzinfo=timezone.utc)  # replied after the fan
            await s.commit()

    run(client, _answered)
    run(client, lambda: client.app.state.ai._watchdog_scan())
    assert fake.calls == []  # nothing to do


# ── item 2: re-process tierFiltered chats whose own country is Tier 1 ──
def _run_reprocess(client, apply):
    r = client.post("/api/system/reprocess-tierfiltered", json={"dry_run": not apply}, headers=H)
    assert r.status_code == 200
    for _ in range(200):
        job = client.get("/api/system/reprocess-tierfiltered", headers=H).json()["reprocess"]
        if job and not job["running"]:
            return job
        _spin(client)
    return job


def test_reprocess_dry_run_lists_without_changing(client, directory):
    acc = setup(client, directory, 81, 7011, "rp", peer_countries={"555": "US"})
    set_capital(client, FakeCapital(cresp(tierFiltered=True)))
    _hi(client, acc)
    assert get_chat(client, acc).ai_state == "filtered"
    job = _run_reprocess(client, apply=False)
    assert job["reliable_t1"] == 1 and job["reopened"] == 0
    assert any(c["peer_id"] == "555" and c["country"] == "US" for c in job["candidates"])
    assert get_chat(client, acc).ai_state == "filtered"  # dry run changed nothing


def test_reprocess_apply_reopens_and_answers(client, directory):
    acc = setup(client, directory, 82, 7012, "rp2", peer_countries={"555": "US"})
    set_capital(client, FakeCapital(cresp(tierFiltered=True), cresp(texts=["welcome back"], conversation_id=9)))
    _hi(client, acc)
    assert get_chat(client, acc).ai_state == "filtered"
    job = _run_reprocess(client, apply=True)
    assert job["reopened"] == 1
    chat = get_chat(client, acc)
    assert chat.ai_state == "active" and chat.capital_conversation_id == 9  # re-opened and answered


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
