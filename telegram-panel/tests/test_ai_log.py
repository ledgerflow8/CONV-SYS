"""The AI message log (ai_events), the qualify rule and the global kill switch (client 2026-11-05).

Qualify rule: only an AI reply from a clean Capitalbot response, delivered to Telegram, reports
repliedAt to the portal. Never on credit_over / tier_filtered / error / ai_off / kill switch."""

from datetime import timedelta

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select

from panel.capital import CapitalClient, CapitalError
from panel.main import create_app
from panel.models import Activity, AiEvent, utcnow
from panel.tg.client import AccountInfo, IncomingMessage
from tests.conftest import H, PASSWORD, set_password, speed_up_imports
from tests.test_ai import (  # noqa: F401 (client/directory are fixtures)
    FakeCapital,
    _import,
    at,
    client,
    convos,
    cresp,
    deliver,
    directory,
    fake_client,
    fan,
    run,
    run_turn,
    set_capital,
    setup,
)


def events(c, account_id=None):
    async def _q():
        async with c.app.state.sessionmaker() as s:
            q = select(AiEvent).order_by(AiEvent.id)
            if account_id is not None:
                q = q.where(AiEvent.account_id == account_id)
            return [(e.kind, e.capital_status, e.text, e.error) for e in (await s.scalars(q)).all()]

    return run(c, _q)


def kinds(c, account_id=None):
    return [(k, st) for k, st, _t, _e in events(c, account_id)]


def replied(c):
    return [p for p in convos(c) if "repliedAt" in p]


def hi(c, acc, n=1, when=None, text="hi"):
    deliver(c, acc, IncomingMessage(fan(), tg_msg_id=n, out=False, kind="text", text=text, at=when or at(9, n)))


def test_a_delivered_ai_reply_is_logged_and_qualifies(client, directory):
    acc = setup(client, directory, 200, 20001, "logok")
    set_capital(client, FakeCapital(cresp(texts=["hey!", "how are you"], conversation_id=1)))
    hi(client, acc, text="hello there")
    run_turn(client, acc)

    ev = events(client, acc)
    assert [(k, st) for k, st, _t, _e in ev] == [
        ("fan_msg", None), ("ai_request", "ok"), ("ai_reply_sent", "ok"), ("ai_reply_sent", "ok"),
    ]
    assert ev[0][2] == "hello there"
    assert "[fan]" in ev[1][2] and "fan: hello there" in ev[1][2]
    assert [t for k, _s, t, _e in ev if k == "ai_reply_sent"] == ["hey!", "how are you"]
    assert len(replied(client)) == 1


def test_an_outgoing_message_not_from_the_ai_never_qualifies_but_a_later_ai_reply_does(client, directory):
    acc = setup(client, directory, 201, 20002, "manual")
    hi(client, acc, when=at(9))
    # Typed on a phone / another session: seen by the listener, stored as manual, no repliedAt.
    deliver(client, acc, IncomingMessage(fan(), tg_msg_id=2, out=True, kind="text", text="hey", at=at(9, 1)))
    assert replied(client) == []
    hi(client, acc, n=3, when=at(9, 2))
    set_capital(client, FakeCapital(cresp(texts=["sorry, here now"])))
    run_turn(client, acc)
    r = replied(client)
    assert len(r) == 1 and r[0]["repliedAt"] > "2026-10-07T09:01:00Z"  # the AI's reply time, not the manual one


@pytest.mark.parametrize(
    "resp,status",
    [(cresp(aiCreditOver=True), "credit_over"), (cresp(tierFiltered=True), "tier_filtered"), (cresp(genderFiltered=True), "ok")],
)
def test_no_reply_responses_are_logged_and_never_qualify(client, directory, resp, status):
    acc = setup(client, directory, 202, 20003, "noreply")
    set_capital(client, FakeCapital(resp))
    hi(client, acc)
    run_turn(client, acc)
    assert kinds(client, acc) == [("fan_msg", None), ("ai_request", status)]
    assert replied(client) == []


def test_content_that_comes_with_a_credit_or_tier_flag_is_sent_but_never_qualifies(client, directory):
    acc = setup(client, directory, 203, 20004, "odd")
    set_capital(client, FakeCapital(cresp(texts=["hm"], tierFiltered=True)))
    hi(client, acc)
    run_turn(client, acc)
    assert ("ai_reply_sent", "tier_filtered") in kinds(client, acc)
    assert replied(client) == []
    # The stored AI message row isn't evidence either (it's after the log started): Chat logs agrees.
    assert [c["ai_replied"] for c in client.get("/api/chats").json()["chats"]] == [False]


def test_a_capitalbot_error_is_logged_with_its_detail(client, directory):
    acc = setup(client, directory, 204, 20005, "err")
    set_capital(client, FakeCapital(CapitalError("server", "Capitalbot returned 502", status_code=502)))
    hi(client, acc)
    run_turn(client, acc)
    ev = events(client, acc)
    assert ev[-1][:2] == ("ai_request", "error") and "502" in ev[-1][3]
    assert replied(client) == []


def test_the_credit_pause_logs_once_per_fan_message_not_every_probe(client, directory):
    acc = setup(client, directory, 205, 20006, "pause")
    fake = FakeCapital(cresp(aiCreditOver=True))
    set_capital(client, fake)
    hi(client, acc)
    run_turn(client, acc)
    assert client.get("/api/system/status").json()["ai"]["credits_out"] is True  # the "credits empty" banner
    hi(client, acc, n=2)
    for _ in range(3):  # re-probe wake-ups while still paused
        run_turn(client, acc)
    assert len(fake.calls) == 1
    assert kinds(client, acc)[-2:] == [("fan_msg", None), ("ai_skipped", "credit_over")]  # once, not 3 times
    assert replied(client) == []
    # Credits come back: the banner clears.
    client.app.state.ai.credit_over_until = utcnow() - timedelta(seconds=1)
    set_capital(client, FakeCapital(cresp(texts=["back"])))
    run_turn(client, acc)
    assert client.get("/api/system/status").json()["ai"]["credits_out"] is False
    assert len(replied(client)) == 1


def test_ai_off_account_logs_the_skip_and_never_calls(client, directory):
    acc = _import(client, directory, 206, AccountInfo(20007, "aioff", "+1", "A"))  # no persona, AI off
    fake = FakeCapital()
    set_capital(client, fake)
    hi(client, acc)
    hi(client, acc, n=2)
    assert kinds(client, acc) == [("fan_msg", None), ("ai_skipped", "ai_off"), ("fan_msg", None), ("ai_skipped", "ai_off")]
    assert fake.calls == []


# ── the global kill switch ─────────────────────────────────────────────────────
def test_kill_switch_stops_every_call_logs_and_shows(client, directory):
    acc = setup(client, directory, 207, 20008, "kill")
    fake = FakeCapital(cresp(texts=["back"]))
    set_capital(client, fake)

    assert client.post("/api/system/kill-switch", json={"on": True}, headers=H).json() == {"kill_switch": True}
    ai = client.get("/api/system/status").json()["ai"]
    assert ai["kill_switch"] is True and ai["global_on"] is False
    assert client.app.state.capital.blocked is True

    hi(client, acc)
    run_turn(client, acc)
    run_turn(client, acc)
    assert fake.calls == []
    assert kinds(client, acc) == [("fan_msg", None), ("ai_skipped", "kill_switch")]
    assert replied(client) == []

    client.post("/api/system/kill-switch", json={"on": False}, headers=H)
    assert client.app.state.capital.blocked is False
    run_turn(client, acc)
    assert len(fake.calls) == 1 and len(replied(client)) == 1

    async def _acts():
        async with client.app.state.sessionmaker() as s:
            return [a.message for a in (await s.scalars(select(Activity).where(Activity.kind == "ai_kill_switch"))).all()]

    assert len(run(client, _acts)) == 2  # on and off are both in the activity log


def test_kill_switch_blocks_the_capitalbot_client_itself():
    import asyncio

    import httpx

    async def go():
        async with httpx.AsyncClient() as http:
            cap = CapitalClient("key", http, base_url="http://127.0.0.1:9")  # would fail to connect if called
            cap.blocked = True
            with pytest.raises(CapitalError) as e:
                await cap.generate_response(model_id=1, preset_id=1, account_id="1", user_infos={}, chat_history=[])
            assert e.value.kind == "kill_switch"
            with pytest.raises(CapitalError):
                await cap.catalog()
            assert await cap.statistics() is None

    asyncio.run(go())


def test_kill_switch_survives_a_restart(directory, settings, tmp_path):
    def app():
        return create_app(settings, dist=tmp_path / "x", client_factory=directory.factory)

    with TestClient(app(), base_url="https://panel.example.com") as c:
        set_password(c)
        c.post("/api/auth/login", json={"password": PASSWORD}, headers=H)
        c.post("/api/system/kill-switch", json={"on": True}, headers=H)
    with TestClient(app(), base_url="https://panel.example.com") as c:
        speed_up_imports(c)
        c.post("/api/auth/login", json={"password": PASSWORD}, headers=H)
        assert c.app.state.capital.blocked is True
        assert c.get("/api/system/status").json()["ai"]["kill_switch"] is True


def test_watchdog_obeys_the_kill_switch_and_logs_its_turns(client, directory):
    acc = setup(client, directory, 208, 20009, "watch")
    fake = FakeCapital(cresp(texts=["sorry I missed this"]))
    set_capital(client, fake)
    hi(client, acc, when=(utcnow() - timedelta(minutes=30)).replace(microsecond=0))  # unanswered, old enough

    client.post("/api/system/kill-switch", json={"on": True}, headers=H)
    run(client, client.app.state.ai._watchdog_scan)
    assert fake.calls == []

    client.post("/api/system/kill-switch", json={"on": False}, headers=H)
    run(client, client.app.state.ai._watchdog_scan)
    assert len(fake.calls) == 1
    req = [t for k, _s, t, _e in events(client, acc) if k == "ai_request"]
    assert req and req[0].startswith("[watchdog]")
    assert len(replied(client)) == 1
    assert fake_client(client, acc).sent[-1]["text"] == "sorry I missed this"
