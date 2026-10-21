"""The converted-leads feature: a conversion records a Lead, the Leads API filters/exports it, the
startup backfill picks up old converted chats, and Stats count conversions (client feedback 2026-10-21)."""

import csv
import io
import time

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select

from panel.main import create_app
from panel.models import Chat
from panel.tg.client import AccountInfo, IncomingMessage, PeerInfo
from tests.conftest import H, PASSWORD, set_password, speed_up_imports
from tests.fake_tg import FakeAccount, FakeDirectory
from tests.make_session import key, string_session, telethon_session_bytes
from tests.test_ai import FakeCapital, cresp, deliver, enable_ai, run, run_turn, set_capital


def at(h, m=0, s=0):
    from datetime import datetime, timezone

    return datetime(2026, 10, 7, h, m, s, tzinfo=timezone.utc)


def fan(peer_id="555", username="fan1", phone="+15557770000"):
    return PeerInfo(peer_id=peer_id, username=username, name="Fan One", phone=phone)


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


def _import(client, directory, n, uid, username):
    """Import one account and return its id (by username, so it's reliable with several accounts)."""
    k = key(n)
    directory.add(string_session(k), FakeAccount(AccountInfo(uid, username, "+1", "A")))
    files = [("files", (f"{username}.session", io.BytesIO(telethon_session_bytes(k)), "application/octet-stream"))]
    job = client.post("/api/imports", files=files, headers=H).json()["job_id"]
    for _ in range(100):
        if client.get(f"/api/imports/{job}").json()["done"]:
            break
        time.sleep(0.02)
    accounts = client.get("/api/accounts").json()["accounts"]
    return next(a["id"] for a in accounts if a["username"] == username)


def _convert(client, directory, n, uid, username, peer):
    acc = _import(client, directory, n, uid, username)
    enable_ai(client, acc)
    set_capital(client, FakeCapital(cresp(converted=True, conversation_id=uid)))
    deliver(client, acc, IncomingMessage(peer, tg_msg_id=1, out=False, kind="text", text="subscribed!", at=at(9)))
    run_turn(client, acc, peer.peer_id)
    return acc


def test_conversion_records_a_lead(client, directory):
    _convert(client, directory, 80, 8800, "lead1", fan())
    r = client.get("/api/leads", headers=H).json()
    assert r["total"] == 1
    lead = r["leads"][0]
    assert lead["fan_user_id"] == "555"
    assert lead["fan_username"] == "fan1"
    assert lead["fan_phone"] == "+15557770000"
    assert lead["account_username"] == "lead1"
    assert lead["profile_name"] == "P"
    assert lead["capital_model_id"] == 43
    assert lead["tme_link"] == "https://t.me/fan1"
    assert lead["va"] == ""  # the panel has no portal attribution


def test_non_converted_chat_is_not_a_lead(client, directory):
    acc = _import(client, directory, 81, 8810, "lead2")
    enable_ai(client, acc)
    set_capital(client, FakeCapital(cresp(texts=["hey"], conversation_id=1)))
    deliver(client, acc, IncomingMessage(fan(), tg_msg_id=1, out=False, kind="text", text="hi", at=at(9)))
    run_turn(client, acc, "555")
    assert client.get("/api/leads", headers=H).json()["total"] == 0


def test_filters_and_search(client, directory):
    _convert(client, directory, 82, 8820, "accta", fan(peer_id="111", username="alpha"))
    _convert(client, directory, 83, 8830, "acctb", fan(peer_id="222", username="bravo"))
    all_leads = client.get("/api/leads", headers=H).json()
    assert all_leads["total"] == 2
    assert len(all_leads["accounts"]) == 2

    a_id = next(a["id"] for a in all_leads["accounts"] if a["username"] == "accta")
    only_a = client.get(f"/api/leads?account_id={a_id}", headers=H).json()
    assert only_a["total"] == 1 and only_a["leads"][0]["account_username"] == "accta"

    searched = client.get("/api/leads?q=bravo", headers=H).json()
    assert searched["total"] == 1 and searched["leads"][0]["fan_username"] == "bravo"


def test_export_csv(client, directory):
    _convert(client, directory, 84, 8840, "lead3", fan(peer_id="333", username="charlie"))
    res = client.get("/api/leads/export", headers=H)
    assert res.status_code == 200
    assert "text/csv" in res.headers["content-type"]
    assert "attachment" in res.headers["content-disposition"]
    rows = list(csv.reader(io.StringIO(res.text)))
    assert rows[0][0] == "Fan Telegram ID"
    body = rows[1:]
    assert len(body) == 1
    assert body[0][0] == "333" and "charlie" in body[0]


def test_backfill_creates_leads_for_old_converted_chats(client, directory):
    acc = _import(client, directory, 85, 8850, "lead4")
    enable_ai(client, acc)
    deliver(client, acc, IncomingMessage(fan(), tg_msg_id=1, out=False, kind="text", text="hi", at=at(9)))

    async def _mark_converted_without_lead():
        async with client.app.state.sessionmaker() as s:
            chat = await s.scalar(select(Chat).where(Chat.account_id == acc))
            chat.ai_state = "converted"  # pre-feature data: converted, but no Lead row
            await s.commit()

    run(client, _mark_converted_without_lead)
    assert client.get("/api/leads", headers=H).json()["total"] == 0  # nothing yet

    made = run(client, lambda: client.app.state.service.backfill_leads())
    assert made == 1
    again = run(client, lambda: client.app.state.service.backfill_leads())  # idempotent
    assert again == 0
    assert client.get("/api/leads", headers=H).json()["total"] == 1


def test_stats_count_conversions(client, directory):
    acc = _convert(client, directory, 86, 8860, "lead5", fan())
    overall = client.get("/api/system/stats", headers=H).json()
    assert overall["panel"]["all"]["converted"] == 1
    per_account = client.get(f"/api/accounts/{acc}/stats", headers=H).json()
    assert per_account["all"]["converted"] == 1
