"""`audit-qualified` (panel/audit.py): which chats reported to the portal as replied had no AI reply."""

import csv
import time
from datetime import timedelta

import pytest
from sqlalchemy import select

import panel.audit
from panel.models import AiEvent, Chat, Message, utcnow
from panel.tg.client import AccountInfo, IncomingMessage, PeerInfo, TgError
from tests.conftest import H
from tests.test_ai import _import, client, directory, run  # noqa: F401 (fixtures)


def peer(pid):
    return PeerInfo(peer_id=pid, username=None, name="Fan", phone=None)


def ago(hours):
    return (utcnow() - timedelta(hours=hours)).replace(microsecond=0)


def add_chat(c, account_id, pid, first_in, replied, *, ai_event=False, ai_message=False, manual_message=False):
    """A chat the panel already reported as replied (as the old rule did for any outgoing message)."""

    async def _a():
        async with c.app.state.sessionmaker() as s:
            s.add(Chat(account_id=account_id, peer_id=pid, first_in_at=first_in, first_reply_at=replied, reported_first=True, reported_reply=True, access_hash=42))
            if ai_event:
                s.add(AiEvent(account_id=account_id, peer_id=pid, kind="ai_reply_sent", capital_status="ok", text="hey", created_at=replied))
            if ai_message:
                s.add(Message(account_id=account_id, peer_id=pid, tg_msg_id=7, direction="out", sender="ai", kind="text", text=None, at=replied))
            if manual_message:
                s.add(Message(account_id=account_id, peer_id=pid, tg_msg_id=8, direction="out", sender="manual", kind="text", text="hi", at=replied))
            await s.commit()

    run(c, _a)


def audit(c, since, live=False):
    r = c.post("/api/system/audit-qualified", json={"since": since.isoformat(), "live": live}, headers=H)
    assert r.status_code == 200, r.text
    for _ in range(300):
        job = c.get("/api/system/audit-qualified").json()["audit"]
        if not job["running"]:
            return job
        time.sleep(0.02)
    raise AssertionError("audit didn't finish")


@pytest.fixture(autouse=True)
def fast(monkeypatch):
    monkeypatch.setattr(panel.audit, "LIVE_GAP_SEC", 0)


def test_audit_counts_ai_and_non_ai_replies_and_writes_the_csv(client, directory, settings):
    m = lambda pid, h, out: IncomingMessage(peer(pid), int(h * 10), out, "text", "x", ago(h))  # noqa: E731
    history = {
        "300": [m("300", 30, False), m("300", 29, True)],  # someone replied by hand
        "400": [m("400", 30, False)],  # nothing was ever sent
    }
    a = _import(client, directory, 300, AccountInfo(30001, "auda", "+1", "A"), history=history)
    add_chat(client, a, "100", ago(30), ago(29), ai_event=True)  # AI reply in the log
    add_chat(client, a, "200", ago(30), ago(29), ai_message=True)  # AI reply from before the log (stored row)
    add_chat(client, a, "300", ago(30), ago(29), manual_message=True)
    add_chat(client, a, "400", ago(30), ago(29))
    add_chat(client, a, "500", ago(100), ago(99))  # before `since`: not audited

    job = audit(client, ago(48))
    assert job["checked"] == 4
    assert job["totals"] == {"reported": 4, "ai_reply": 2, "no_ai_reply": 2, "no_outgoing": 0}
    assert job["by_account"]["auda"]["no_ai_reply"] == 2
    assert sum(b["reported"] for b in job["by_day"].values()) == 4

    with open(job["csv_path"]) as fh:
        rows = list(csv.DictReader(fh))
    assert job["csv_path"].startswith(str(settings.data_dir / "audit"))
    assert [(r["peer_id"], r["has_outgoing"], r["ai_reply_logged"]) for r in rows] == [("300", "yes", "no"), ("400", "unknown", "no")]
    assert set(rows[0]) == {"account", "peer_id", "first_msg_at", "reported_replied_at", "has_outgoing", "ai_reply_logged"}

    # --live reads Telegram for the two unproven chats only.
    job = audit(client, ago(48), live=True)
    assert job["live_total"] == 2
    assert job["totals"]["no_outgoing"] == 1
    with open(job["csv_path"]) as fh:
        assert [(r["peer_id"], r["has_outgoing"]) for r in csv.DictReader(fh)] == [("300", "yes"), ("400", "no")]
    assert client.app.state.service.manager.get(a).history_reads == 2

    # Read-only: nothing changed.
    async def _q():
        async with client.app.state.sessionmaker() as s:
            return [(c.peer_id, c.reported_reply) for c in (await s.scalars(select(Chat).order_by(Chat.peer_id))).all()]

    assert all(rep for _p, rep in run(client, _q))


def test_live_audit_waits_out_a_short_floodwait_and_skips_an_account_on_a_long_one(client, directory, monkeypatch):
    slept = []

    async def fake_sleep(sec):
        slept.append(sec)

    monkeypatch.setattr(panel.audit.asyncio, "sleep", fake_sleep)
    hist = lambda pid: {pid: [IncomingMessage(peer(pid), 1, False, "text", "x", ago(30))]}  # noqa: E731
    short = TgError("limited", "Telegram asked to wait 5s", "FloodWaitError", retry_after=5)
    long = TgError("limited", "Telegram asked to wait 900s", "FloodWaitError", retry_after=900)
    a = _import(client, directory, 301, AccountInfo(30002, "fla", "+1", "A"), history=hist("600"), history_errors=[short])
    add_chat(client, a, "600", ago(30), ago(29))
    b = _import(client, directory, 302, AccountInfo(30003, "flb", "+1", "B"), history={**hist("700"), **hist("701")}, history_errors=[long])
    add_chat(client, b, "700", ago(30), ago(29))
    add_chat(client, b, "701", ago(30), ago(29))

    job = audit(client, ago(48), live=True)
    assert 6 in slept  # waited out the 5s FloodWait, then read the chat
    assert job["by_account"]["fla"]["no_outgoing"] == 1
    with open(job["csv_path"]) as fh:
        got = {r["peer_id"]: r["has_outgoing"] for r in csv.DictReader(fh)}
    assert got == {"600": "no", "700": "skipped", "701": "skipped"}
    assert any("900s" in n for n in job["notes"])


def test_audit_validates_since(client):
    assert client.post("/api/system/audit-qualified", json={"since": (utcnow() + timedelta(hours=1)).isoformat()}, headers=H).status_code == 400
    assert client.get("/api/system/audit-qualified").json() == {"audit": None}


def test_cli_prints_totals_by_account_and_day(monkeypatch, capsys):
    import httpx

    import panel.__main__ as cli

    job = {
        "live": True, "running": False, "live_done": 2, "live_total": 2, "error": None, "notes": ["@a: Telegram asked to wait 900s"],
        "totals": {"reported": 3, "ai_reply": 1, "no_ai_reply": 2, "no_outgoing": 1},
        "by_account": {"a": {"reported": 3, "ai_reply": 1, "no_ai_reply": 2, "no_outgoing": 1}},
        "by_day": {"2026-11-01": {"reported": 3, "ai_reply": 1, "no_ai_reply": 2, "no_outgoing": 1}},
        "csv_path": "/var/data/audit/x.csv",
    }
    seen = []

    def handler(request):
        seen.append((request.method, request.content))
        return httpx.Response(200, json={"audit": job})

    monkeypatch.setattr(cli, "_panel_client", lambda: (httpx.Client(transport=httpx.MockTransport(handler)), "http://panel/api/system"))
    assert cli.main(["panel", "audit-qualified", "--since", "2026-11-01T00:00:00Z", "--live"]) == 0
    out = capsys.readouterr().out
    assert "@a" in out and "2026-11-01" in out and "no_outgoing" in out and "/var/data/audit/x.csv" in out
    assert seen[0][0] == "POST" and b'"live":true' in seen[0][1].replace(b" ", b"")
    assert cli.main(["panel", "audit-qualified"]) == 2  # --since is required
