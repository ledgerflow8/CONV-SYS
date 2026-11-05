"""Chat logs API (routes/chats.py): the chat list with filters, and one chat's live messages + AI log."""

from panel.tg.client import IncomingMessage, TgError
from tests.conftest import H
from tests.test_ai import FakeCapital, at, client, cresp, deliver, directory, fan, run_turn, set_capital, setup  # noqa: F401


def two_chats(c, directory):
    """Chat 555 got an AI reply; chat 666 hit the credit pause and never got one."""
    hist = {
        "555": [IncomingMessage(fan(), 1, False, "text", "hi", at(9)), IncomingMessage(fan(), 10_001, True, "text", "hey!", at(9, 1))],
        "666": [IncomingMessage(fan("666", "fan2"), 2, False, "text", "hello?", at(10))],
    }
    acc = setup(c, directory, 400, 40001, "logs", history=hist)
    set_capital(c, FakeCapital(cresp(texts=["hey!"]), cresp(aiCreditOver=True)))
    deliver(c, acc, hist["555"][0])
    run_turn(c, acc)
    deliver(c, acc, hist["666"][0])
    run_turn(c, acc, "666")
    return acc


def test_list_filters_by_ai_replied_status_account_and_date(client, directory):
    acc = two_chats(client, directory)
    all_ = client.get("/api/chats").json()
    assert all_["total"] == 2
    by_peer = {c["peer_id"]: c for c in all_["chats"]}
    assert by_peer["555"]["ai_replied"] is True and by_peer["555"]["last_status"] == "ok" and by_peer["555"]["reported_replied_at"]
    assert by_peer["666"]["ai_replied"] is False and by_peer["666"]["last_status"] == "credit_over"
    assert by_peer["666"]["reported_replied_at"] is None
    assert "credit_over" in all_["statuses"] and all_["accounts"][0]["username"] == "logs"

    assert [c["peer_id"] for c in client.get("/api/chats?ai_replied=no").json()["chats"]] == ["666"]
    assert [c["peer_id"] for c in client.get("/api/chats?ai_replied=yes").json()["chats"]] == ["555"]
    assert [c["peer_id"] for c in client.get("/api/chats?capital_status=credit_over").json()["chats"]] == ["666"]
    assert client.get(f"/api/chats?account_id={acc + 1}").json()["total"] == 0
    assert client.get("/api/chats?date_from=2026-10-07&date_to=2026-10-07").json()["total"] == 2  # `to` includes the whole day
    assert client.get("/api/chats?date_from=2026-10-08").json()["total"] == 0
    assert client.get("/api/chats?capital_status=nope").status_code == 400


def test_detail_shows_live_messages_by_side_and_the_ai_timeline(client, directory):
    acc = two_chats(client, directory)
    d = client.get(f"/api/chats/{acc}/555").json()
    assert d["source"] == "telegram"
    assert [(m["side"], m["by"], m["text"]) for m in d["messages"]] == [("fan", None, "hi"), ("model", "ai", "hey!")]
    assert [(e["kind"], e["capital_status"]) for e in d["events"]] == [("fan_msg", None), ("ai_request", "ok"), ("ai_reply_sent", "ok")]
    assert d["chat"]["ai_replied"] is True

    d = client.get(f"/api/chats/{acc}/666").json()
    assert [(e["kind"], e["capital_status"]) for e in d["events"]] == [("fan_msg", None), ("ai_request", "credit_over")]
    assert d["chat"]["ai_replied"] is False
    assert client.get(f"/api/chats/{acc}/999").status_code == 404


def test_detail_falls_back_to_stored_messages_when_telegram_fails_or_the_account_is_off(client, directory):
    acc = two_chats(client, directory)
    client.app.state.service.manager.get(acc)._fake.history_errors.append(TgError("limited", "Telegram asked to wait 30s", "FloodWaitError", retry_after=30))
    d = client.get(f"/api/chats/{acc}/555").json()
    assert d["source"] == "stored" and "30s" in d["note"]
    assert [(m["side"], m["by"]) for m in d["messages"]] == [("fan", None), ("model", "ai")]

    client.post(f"/api/accounts/{acc}/power", json={"on": False}, headers=H)
    d = client.get(f"/api/chats/{acc}/555").json()
    assert d["source"] == "stored" and "isn't connected" in d["note"]


def test_chat_logs_need_login(directory, settings, tmp_path):
    from fastapi.testclient import TestClient

    from panel.main import create_app

    with TestClient(create_app(settings, dist=tmp_path / "x", client_factory=directory.factory), base_url="https://panel.example.com") as c:
        assert c.get("/api/chats").status_code == 401
        assert c.get("/api/chats/1/2").status_code == 401


