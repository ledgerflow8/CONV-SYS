"""Step 3: the AI reply worker (panel/ai.py) end-to-end on a fake Telegram + a fake Capitalbot.

Covers every response-flag path, a full text reply, a photo both ways, the already-answered guard,
the debounce trigger, and the two error classes (pause vs. no-pause)."""

import io
import time
from datetime import datetime, timezone

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select

from panel.capital import CapitalError, CapitalResponse, ContentItem
from panel.main import create_app
from panel.models import Account, Activity, Chat, Message, OutboxItem, Profile
from panel.tg.client import AccountInfo, IncomingMessage, PeerInfo
from tests.conftest import H, PASSWORD, set_password, speed_up_imports
from tests.fake_tg import FakeAccount, FakeDirectory
from tests.make_session import key, string_session, telethon_session_bytes

FLAG_NAMES = (
    "converted", "underage", "timewaste", "tierFiltered", "genderFiltered", "aiCreditOver",
    "messagedAlready", "internalAccount", "ignored", "ppvExhausted", "chatCooldown",
)


def cresp(texts=(), media=(), conversation_id=None, cooldown_until=None, **flags):
    content = [ContentItem("text", t) for t in texts] + [ContentItem(t, p) for t, p in media]
    f = {n: False for n in FLAG_NAMES}
    f.update({k: bool(v) for k, v in flags.items()})
    return CapitalResponse(content=content, flags=f, conversation_id=conversation_id, cooldown_until=cooldown_until, raw={"stub": True})


class FakeCapital:
    def __init__(self, *responses, on_call=None):
        self.configured = True
        self._responses = list(responses)
        self.calls = []
        self._on_call = on_call

    async def generate_response(self, **kwargs):
        self.calls.append(kwargs)
        if self._on_call is not None:
            await self._on_call()
        r = self._responses.pop(0)
        if isinstance(r, Exception):
            raise r
        return r


def at(h, m=0, s=0):
    return datetime(2026, 10, 7, h, m, s, tzinfo=timezone.utc)


def fan(peer_id="555", username="fan1"):
    return PeerInfo(peer_id=peer_id, username=username, name="Fan One", phone="+15557770000")


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


def enable_ai(c, account_id, overrides=None):
    async def _e():
        async with c.app.state.sessionmaker() as s:
            p = Profile(name="P", capital_model_id=43, capital_preset_id=88, overrides={"city": "Miami"})
            s.add(p)
            await s.flush()
            acc = await s.get(Account, account_id)
            acc.profile_id = p.id
            acc.ai_on = True
            acc.profile_overrides = overrides or {}
            await s.commit()
            return p.id

    return run(c, _e)


def set_capital(c, fake):
    c.app.state.ai.capital = fake


def deliver(c, account_id, msg):
    async def _d():
        await c.app.state.service.manager.get(account_id).deliver(msg)

    run(c, lambda: c.app.state.service.manager.get(account_id).deliver(msg))


def run_turn(c, account_id, peer="555"):
    run(c, lambda: c.app.state.ai.run_turn(account_id, peer))


def get_chat(c, account_id, peer="555"):
    async def _q():
        async with c.app.state.sessionmaker() as s:
            return await s.scalar(select(Chat).where(Chat.account_id == account_id, Chat.peer_id == peer))

    return run(c, _q)


def fake_client(c, account_id):
    return c.app.state.service.manager.get(account_id)


def activities(c):
    async def _q():
        async with c.app.state.sessionmaker() as s:
            return [(a.kind, a.message) for a in (await s.scalars(select(Activity).order_by(Activity.id))).all()]

    return run(c, _q)


def setup(c, directory, n, uid, username, **fake_kw):
    acc = _import(c, directory, n, AccountInfo(uid, username, "+1", "A"), **fake_kw)
    enable_ai(c, acc)
    return acc


# ── a full text reply ───────────────────────────────────────────────────────
def test_text_reply_is_sent_recorded_and_reported(client, directory):
    acc = setup(client, directory, 70, 7100, "alice")
    set_capital(client, FakeCapital(cresp(texts=["hey!", "how are you"], conversation_id=4821337)))
    deliver(client, acc, IncomingMessage(fan(), tg_msg_id=1, out=False, kind="text", text="hi", at=at(9)))
    run_turn(client, acc)

    fc = fake_client(client, acc)
    assert [s["text"] for s in fc.sent] == ["hey!", "how are you"]
    assert fc.read_marked == 1  # chat marked read before replying

    async def _check():
        async with client.app.state.sessionmaker() as s:
            msgs = (await s.scalars(select(Message).where(Message.account_id == acc, Message.direction == "out"))).all()
            chat = await s.scalar(select(Chat).where(Chat.account_id == acc))
            convos = (await s.scalars(select(OutboxItem).where(OutboxItem.kind == "convo"))).all()
            return [m.sender for m in msgs], chat.capital_conversation_id, chat.first_reply_at, {o.dedupe_key.rsplit(":", 1)[-1] for o in convos}

    senders, conv_id, first_reply, suffixes = run(client, _check)
    assert senders == ["ai", "ai"]
    assert conv_id == 4821337
    assert first_reply is not None
    assert "reply" in suffixes  # a first-reply convo event was enqueued for the portal


# ── every flag path ──────────────────────────────────────────────────────────
@pytest.mark.parametrize(
    "flag,state,reason",
    [
        ("underage", "stopped", "underage"),
        ("timewaste", "stopped", "timewaste"),
        ("ppvExhausted", "stopped", "ppvExhausted"),
        ("tierFiltered", "filtered", "tierFiltered"),
        ("genderFiltered", "filtered", "genderFiltered"),
        ("ignored", "filtered", "ignored"),
        ("messagedAlready", "filtered", "messagedAlready"),
        ("internalAccount", "filtered", "internalAccount"),
    ],
)
def test_stop_flags_set_ai_state(client, directory, flag, state, reason):
    acc = setup(client, directory, 71, 7200 + hash(flag) % 500, flag.lower())
    set_capital(client, FakeCapital(cresp(**{flag: True})))
    deliver(client, acc, IncomingMessage(fan(), tg_msg_id=1, out=False, kind="text", text="hi", at=at(9)))
    run_turn(client, acc)
    chat = get_chat(client, acc)
    assert (chat.ai_state, chat.ai_state_reason) == (state, reason)
    assert fake_client(client, acc).sent == []  # empty content → nothing sent


def test_converted_keeps_calling_then_unconverts(client, directory):
    acc = setup(client, directory, 72, 7300, "carol")
    set_capital(client, FakeCapital(cresp(converted=True), cresp(texts=["i cannot find you on my OF :("])))
    deliver(client, acc, IncomingMessage(fan(), tg_msg_id=1, out=False, kind="text", text="subscribed!", at=at(9)))
    run_turn(client, acc)
    assert get_chat(client, acc).ai_state == "converted"

    # A later call that comes back with content and converted:false resumes the chat (un-convert).
    deliver(client, acc, IncomingMessage(fan(), tg_msg_id=2, out=False, kind="text", text="hey", at=at(10)))
    run_turn(client, acc)
    chat = get_chat(client, acc)
    assert chat.ai_state == "active"
    assert "i cannot find you" in fake_client(client, acc).sent[-1]["text"]


def test_chat_cooldown_sends_the_shower_message_and_sets_cooldown(client, directory):
    acc = setup(client, directory, 73, 7400, "dana")
    until = int(at(12).timestamp())
    set_capital(client, FakeCapital(cresp(texts=["brb going to shower"], chatCooldown=True, cooldown_until=until)))
    deliver(client, acc, IncomingMessage(fan(), tg_msg_id=1, out=False, kind="text", text="more?", at=at(9)))
    run_turn(client, acc)
    chat = get_chat(client, acc)
    assert chat.cooldown_until == at(12)
    assert fake_client(client, acc).sent[-1]["text"] == "brb going to shower"  # the turn that starts the cooldown still sends


def test_ai_credit_over_pauses_all_calls(client, directory):
    acc = setup(client, directory, 74, 7500, "erin")
    fake = FakeCapital(cresp(aiCreditOver=True))
    set_capital(client, fake)
    deliver(client, acc, IncomingMessage(fan(), tg_msg_id=1, out=False, kind="text", text="hi", at=at(9)))
    run_turn(client, acc)
    assert client.app.state.ai.credit_over_until is not None
    # A second turn must not reach Capitalbot while paused.
    deliver(client, acc, IncomingMessage(fan(), tg_msg_id=2, out=False, kind="text", text="?", at=at(9, 1)))
    run_turn(client, acc)
    assert len(fake.calls) == 1


# ── media both ways ────────────────────────────────────────────────────────────
def test_photo_in_is_uploaded_and_photo_out_is_sent(client, directory, tmp_path):
    acc = setup(client, directory, 75, 7600, "fay", media={("555", 1): b"\xff\xd8fan-photo"})
    out_pic = tmp_path / "reply.jpg"
    out_pic.write_bytes(b"\xff\xd8reply")
    set_capital(client, FakeCapital(cresp(texts=["cute!"], media=[("image", str(out_pic))])))
    deliver(client, acc, IncomingMessage(fan(), tg_msg_id=1, out=False, kind="image", text=None, at=at(9)))
    run_turn(client, acc)

    fake = client.app.state.ai.capital
    assert fake.calls[0]["file_path"] is not None  # the fan's photo was uploaded for analysis
    sent = fake_client(client, acc).sent
    assert any(s["type"] == "text" and s["text"] == "cute!" for s in sent)
    assert any(s["type"] == "file" for s in sent)  # the AI's photo was sent back


# ── the already-answered guard ──────────────────────────────────────────────────
def test_reply_dropped_if_chat_answered_during_the_call(client, directory):
    acc = setup(client, directory, 76, 7700, "gwen")

    async def manual_reply_midcall():
        # The client typed a reply on their own phone while Capitalbot was thinking.
        await client.app.state.service.manager.get(acc).deliver(
            IncomingMessage(fan(), tg_msg_id=50, out=True, kind="text", text="typed by hand", at=at(9, 30))
        )

    set_capital(client, FakeCapital(cresp(texts=["late AI reply"]), on_call=manual_reply_midcall))
    deliver(client, acc, IncomingMessage(fan(), tg_msg_id=1, out=False, kind="text", text="hi", at=at(9)))
    run_turn(client, acc)

    sent_texts = [s.get("text") for s in fake_client(client, acc).sent]
    assert "late AI reply" not in sent_texts
    assert any(k == "ai_dropped" for k, _ in activities(client))


# ── error handling ──────────────────────────────────────────────────────────────
def test_client_error_pauses_the_account_ai(client, directory):
    acc = setup(client, directory, 77, 7800, "hana")
    set_capital(client, FakeCapital(CapitalError("client", "bad preset", status_code=400, pause=True)))
    deliver(client, acc, IncomingMessage(fan(), tg_msg_id=1, out=False, kind="text", text="hi", at=at(9)))
    run_turn(client, acc)

    async def _ai_on():
        async with client.app.state.sessionmaker() as s:
            return (await s.get(Account, acc)).ai_on

    assert run(client, _ai_on) is False
    assert any(k == "ai_error" for k, _ in activities(client))


def test_timeout_logs_but_leaves_ai_on_and_sends_nothing(client, directory):
    acc = setup(client, directory, 78, 7900, "iris")
    set_capital(client, FakeCapital(CapitalError("timeout", "slow")))
    deliver(client, acc, IncomingMessage(fan(), tg_msg_id=1, out=False, kind="text", text="hi", at=at(9)))
    run_turn(client, acc)

    async def _ai_on():
        async with client.app.state.sessionmaker() as s:
            return (await s.get(Account, acc)).ai_on

    assert run(client, _ai_on) is True
    assert fake_client(client, acc).sent == []


# ── the debounce trigger (notify → run) ──────────────────────────────────────────
def test_fan_message_triggers_a_debounced_reply(client, directory):
    acc = setup(client, directory, 79, 8000, "jade")

    async def _set_debounce():
        async with client.app.state.sessionmaker() as s:
            from panel.db import set_setting

            await set_setting(s, "ai_debounce_sec", 0)
            await s.commit()

    run(client, _set_debounce)
    set_capital(client, FakeCapital(cresp(texts=["auto reply"])))
    deliver(client, acc, IncomingMessage(fan(), tg_msg_id=1, out=False, kind="text", text="hi", at=at(9)))

    async def _wait():
        import asyncio

        await asyncio.sleep(0.1)  # let the debounce task fire

    run(client, _wait)
    assert any(s.get("text") == "auto reply" for s in fake_client(client, acc).sent)
