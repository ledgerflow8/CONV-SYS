"""Reaching a chat after a restart (client 2026-11-03).

A StringSession doesn't persist Telethon's entity cache, so after a restart/deploy a bare user id
can't be resolved ("Could not find the input entity for PeerUser(...)") and every reply, typing and
mark_read to a pre-restart chat fails. We persist each peer's access_hash and send via InputPeerUser.
These tests model a cold cache with FakeAccount(require_access_hash=True)."""

from datetime import datetime, timezone

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select

from panel.main import create_app
from panel.models import Chat
from panel.tg.client import IncomingMessage, PeerInfo
from tests.conftest import H, PASSWORD, make_settings, set_password, speed_up_imports
from tests.fake_tg import FakeDirectory
from tests.test_ai import FakeCapital, cresp, deliver, fake_client, get_chat, run, run_turn, set_capital, setup


def at(h, m=0):
    return datetime(2026, 11, 3, h, m, tzinfo=timezone.utc)


def fan(access_hash):
    # A fan whose number is hidden; access_hash is what Telegram gives us on the message.
    return PeerInfo(peer_id="555", username="fan", name="Fan", phone=None, access_hash=access_hash)


@pytest.fixture
def directory():
    return FakeDirectory()


@pytest.fixture
def client(directory, tmp_path):
    app = create_app(make_settings(tmp_path), dist=tmp_path / "x", client_factory=directory.factory)
    with TestClient(app, base_url="https://panel.example.com") as c:
        set_password(c)
        speed_up_imports(c)
        c.post("/api/auth/login", json={"password": PASSWORD}, headers=H)
        yield c


def _chat_hash(client, acc):
    return get_chat(client, acc).access_hash


def test_reply_to_pre_restart_chat_succeeds_via_stored_hash(client, directory):
    # The account's cache is cold (require_access_hash=True): only InputPeerUser works.
    acc = setup(client, directory, 70, 7000, "a", require_access_hash=True, peer_hashes={"555": 42424242})
    set_capital(client, FakeCapital(cresp(texts=["hi there"], conversation_id=1)))
    # The fan's message carried the access_hash; it must be persisted on the chat.
    deliver(client, acc, IncomingMessage(fan(42424242), tg_msg_id=1, out=False, kind="text", text="hey", at=at(9)))
    assert _chat_hash(client, acc) == 42424242

    run_turn(client, acc)  # cold cache, but we send with the stored hash
    sent = fake_client(client, acc).sent
    assert [s["text"] for s in sent] == ["hi there"]
    assert sent[0]["access_hash"] == 42424242  # sent via InputPeerUser, not a bare id


def test_without_a_hash_the_send_is_skipped_then_warm_backfill_fixes_it(client, directory):
    acc = setup(client, directory, 71, 7001, "b", require_access_hash=True, peer_hashes={"555": 99})
    set_capital(client, FakeCapital(cresp(texts=["one"]), cresp(texts=["two"], conversation_id=2)))
    # A chat from before this change: the message carried no access_hash, so none is stored.
    deliver(client, acc, IncomingMessage(fan(None), tg_msg_id=1, out=False, kind="text", text="hey", at=at(9)))
    assert _chat_hash(client, acc) is None

    run_turn(client, acc)  # cold cache, no hash → the reply piece can't be delivered
    assert fake_client(client, acc).sent == []
    acts = [a for a in client.get("/api/system/activity", headers=H).json()["activity"] if a["kind"] == "ai_send_failed"]
    assert acts and "no access hash" in acts[0]["message"]

    # Startup warms the entity cache from dialogs and stores the hash; the next turn then delivers.
    run(client, lambda: client.app.state.service.warm_access_hashes())
    assert _chat_hash(client, acc) == 99
    run_turn(client, acc)
    assert any(s.get("text") == "two" for s in fake_client(client, acc).sent)


def test_typing_failure_never_blocks_the_text(client, directory):
    # typing raises, but the text must still go out (requirement 4).
    acc = setup(client, directory, 72, 7002, "c", typing_error=True, peer_hashes={"555": 7})
    set_capital(client, FakeCapital(cresp(texts=["sent anyway"], conversation_id=1)))
    deliver(client, acc, IncomingMessage(fan(7), tg_msg_id=1, out=False, kind="text", text="hey", at=at(9)))
    run_turn(client, acc)
    assert any(s.get("text") == "sent anyway" for s in fake_client(client, acc).sent)
