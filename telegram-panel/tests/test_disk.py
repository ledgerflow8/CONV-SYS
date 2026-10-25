"""Disk housekeeping and convo recovery (PLAN.md §12): the data disk filled on 2026-10-25."""

import os
import sqlite3
import time
from datetime import timedelta
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select

import panel.recovery
from panel import housekeeping
from panel.db import init_db, make_engine, make_sessionmaker
from panel.main import create_app
from panel.models import Account, Activity, Chat, Message, OutboxItem, utcnow
from panel.tg.client import AccountInfo, IncomingMessage, PeerInfo, TgError
from tests.conftest import H, PASSWORD, set_password, speed_up_imports
from tests.fake_tg import FakeAccount, FakeDirectory
from tests.test_events import _convo, _deliver, _import, _outbox

# ── housekeeping ─────────────────────────────────────────────────────────────


@pytest.fixture
async def db(tmp_path):
    engine = make_engine(tmp_path / "data" / "panel.db")
    await init_db(engine)
    yield engine, make_sessionmaker(engine)
    await engine.dispose()


async def _account(s) -> Account:
    acc = Account(tg_user_id=1, username="a", session_enc=b"x", auth_key_sha256="k", api_id=1, api_hash="h")
    s.add(acc)
    await s.flush()
    return acc


def _msg(acc_id, peer, n, at, sender="fan", text="hello"):
    return Message(account_id=acc_id, peer_id=peer, tg_msg_id=n, direction="out" if sender != "fan" else "in", sender=sender, kind="text", text=text, at=at)


async def test_prune_messages_keeps_each_chats_ai_history_and_ai_reply_rows(db):
    _engine, sm = db
    old = utcnow() - timedelta(days=40)
    async with sm() as s:
        acc = await _account(s)
        # Busy chat: 70 old messages (every 7th an AI reply) → only the newest 50 stay intact.
        for i in range(70):
            s.add(_msg(acc.id, "big", i, old + timedelta(minutes=i), sender="ai" if i % 7 == 0 else "fan"))
        # Quiet chat: 5 old messages, all within its newest 50 → untouched.
        for i in range(5):
            s.add(_msg(acc.id, "small", i, old + timedelta(minutes=i)))
        # Recent messages are never touched.
        s.add(_msg(acc.id, "new", 1, utcnow()))
        await s.commit()

        deleted, blanked = await housekeeping.prune_messages(s)
        rows = (await s.scalars(select(Message).order_by(Message.peer_id, Message.tg_msg_id))).all()

    big = [m for m in rows if m.peer_id == "big"]
    oldest20 = range(0, 20)
    ai_in_oldest20 = [i for i in oldest20 if i % 7 == 0]  # 0, 7, 14
    assert deleted == 20 - len(ai_in_oldest20)
    assert blanked == len(ai_in_oldest20)
    # AI rows survive (the all-time "AI replies" stat) but lose their text; the newest 50 are intact.
    assert [m.tg_msg_id for m in big if m.tg_msg_id < 20] == ai_in_oldest20
    assert all(m.text is None for m in big if m.tg_msg_id < 20)
    assert [m.tg_msg_id for m in big if m.tg_msg_id >= 20] == list(range(20, 70))
    assert all(m.text == "hello" for m in big if m.tg_msg_id >= 20)
    assert len([m for m in rows if m.peer_id == "small"]) == 5
    assert len([m for m in rows if m.peer_id == "new"]) == 1


async def test_prune_rows_drops_old_delivered_outbox_and_activity_never_pending(db):
    _engine, sm = db
    now = utcnow()
    async with sm() as s:
        for status, age in (("sent", 8), ("sent", 1), ("pending", 60), ("failed", 31), ("failed", 5)):
            s.add(OutboxItem(kind="convo", payload={}, status=status, created_at=now - timedelta(days=age)))
        s.add(Activity(level="info", kind="x", message="old", at=now - timedelta(days=31)))
        s.add(Activity(level="info", kind="x", message="new", at=now))
        await s.commit()
        outbox, activity, _imports = await housekeeping.prune_rows(s)
        left = sorted((r.status, (now - r.created_at).days) for r in (await s.scalars(select(OutboxItem))).all())
        acts = [a.message for a in (await s.scalars(select(Activity))).all()]
    assert (outbox, activity) == (2, 1)
    assert left == [("failed", 5), ("pending", 60), ("sent", 1)]
    assert acts == ["new"]


def test_sweep_media_removes_leftovers(tmp_path):
    d = tmp_path / "ai_media"
    d.mkdir()
    (d / "old.mp4").write_bytes(b"x")
    (d / "new.jpg").write_bytes(b"x")
    hour_ago = time.time() - 3600
    os.utime(d / "old.mp4", (hour_ago, hour_ago))
    assert housekeeping.sweep_media(d) == 1
    assert [f.name for f in d.iterdir()] == ["new.jpg"]
    assert housekeeping.sweep_media(d, max_age_sec=0) == 1  # startup: nothing is in flight
    assert list(d.iterdir()) == []


async def test_sweep_avatars_removes_orphans_and_oversized(db, tmp_path):
    _engine, sm = db
    d = tmp_path / "avatars"
    d.mkdir()
    async with sm() as s:
        acc = await _account(s)
        acc.avatar_path = str(d / f"{acc.id}.jpg")
        await s.commit()
        (d / f"{acc.id}.jpg").write_bytes(b"jpg")
        (d / "999.jpg").write_bytes(b"orphan")
        assert await housekeeping.sweep_avatars(s, d) == 1
        assert sorted(f.name for f in d.iterdir()) == [f"{acc.id}.jpg"]

        (d / f"{acc.id}.jpg").write_bytes(b"x" * (housekeeping.AVATAR_MAX_BYTES + 1))
        assert await housekeeping.sweep_avatars(s, d) == 1
        await s.commit()
        assert (await s.get(Account, acc.id)).avatar_path is None


def test_disk_usage_levels(tmp_path, monkeypatch):
    def fake(pct):
        return lambda _p: type("U", (), {"total": 1000, "used": pct * 10, "free": 1000 - pct * 10})()

    for pct, level in ((50, "ok"), (80, "warn"), (85, "warn"), (90, "critical"), (99, "critical")):
        monkeypatch.setattr(housekeeping.shutil, "disk_usage", fake(pct))
        assert housekeeping.disk_usage(tmp_path)["level"] == level


async def test_run_once_logs_a_warning_when_the_disk_is_high(db, tmp_path, monkeypatch):
    engine, sm = db
    monkeypatch.setattr(housekeeping.shutil, "disk_usage", lambda _p: type("U", (), {"total": 100, "used": 85, "free": 15})())
    await housekeeping.Housekeeper(engine, sm, tmp_path / "data").run_once()
    async with sm() as s:
        acts = (await s.scalars(select(Activity).where(Activity.kind == "disk_high"))).all()
    assert len(acts) == 1 and "85.0% full" in acts[0].message


async def test_compact_and_checkpoint(db, tmp_path, monkeypatch):
    engine, sm = db
    async with sm() as s:
        acc = await _account(s)
        for i in range(2000):
            s.add(_msg(acc.id, "p", i, utcnow(), text="x" * 500))
        await s.commit()
        await s.execute(Message.__table__.delete())
        await s.commit()
    r = await housekeeping.compact(engine, tmp_path / "data")
    assert r["after_bytes"] < r["before_bytes"]
    wal = tmp_path / "data" / "panel.db-wal"
    assert not wal.exists() or wal.stat().st_size == 0  # truncated by the checkpoint

    monkeypatch.setattr(housekeeping.shutil, "disk_usage", lambda _p: type("U", (), {"total": 100, "used": 99, "free": 1})())
    with pytest.raises(RuntimeError, match="Not enough free disk"):
        await housekeeping.compact(engine, tmp_path / "data")


async def test_checkpoint_completes_and_truncates_the_wal(db, tmp_path):
    engine, sm = db
    async with sm() as s:
        acc = await _account(s)
        for i in range(500):
            s.add(_msg(acc.id, "p", i, utcnow(), text="x" * 500))
        await s.commit()
    assert (tmp_path / "data" / "panel.db-wal").stat().st_size > 0
    cp = await housekeeping.checkpoint(engine)
    assert cp.complete and not cp.busy and cp.wal_bytes == 0


async def test_checkpoint_reports_a_reader_that_blocks_it(tmp_path):
    from sqlalchemy import event

    path = tmp_path / "busy" / "panel.db"
    engine = make_engine(path)

    @event.listens_for(engine.sync_engine, "connect")
    def _short_wait(conn, _rec):  # runs after make_engine's pragmas: don't wait 5 s in a test
        conn.cursor().execute("PRAGMA busy_timeout=200")

    await init_db(engine)
    sm = make_sessionmaker(engine)
    async with sm() as s:
        acc = await _account(s)
        s.add(_msg(acc.id, "p", 1, utcnow()))
        await s.commit()
    reader = sqlite3.connect(path)  # a read left open on the WAL, the way a stuck query would
    reader.execute("BEGIN")
    reader.execute("SELECT count(*) FROM messages").fetchone()
    try:
        cp = await housekeeping.checkpoint(engine)
        assert cp.busy and not cp.complete and cp.wal_bytes > 0
    finally:
        reader.rollback()
        reader.close()
    assert (await housekeeping.checkpoint(engine)).complete
    await engine.dispose()


async def test_failed_checkpoints_are_logged_and_escalate(db, tmp_path, monkeypatch):
    engine, sm = db
    hk = housekeeping.Housekeeper(engine, sm, tmp_path / "data")
    stuck = housekeeping.CheckpointResult(complete=False, busy=True, wal_frames=900, checkpointed=0, wal_bytes=300 * 1024 * 1024)

    async def fake(_engine):
        return stuck

    monkeypatch.setattr(housekeeping, "checkpoint", fake)
    for _ in range(3):
        await hk.run_once()
    async with sm() as s:
        acts = (await s.scalars(select(Activity).where(Activity.kind == "wal_checkpoint").order_by(Activity.id))).all()
    assert [a.level for a in acts] == ["warn", "warn", "error"]  # error from the 3rd hour in a row
    assert "the database was busy" in acts[0].message and "300.0 MB" in acts[0].message and "3 hourly attempts" in acts[2].message
    assert hk.checkpoint_failures == 3

    # A WAL over the cap counts as a failure even if the checkpoint itself finished.
    stuck = housekeeping.CheckpointResult(complete=True, busy=False, wal_frames=0, checkpointed=0, wal_bytes=housekeeping.WAL_WARN_BYTES + 1)
    await hk.run_once()
    assert hk.checkpoint_failures == 4

    # One good checkpoint clears the streak and logs nothing.
    stuck = housekeeping.CheckpointResult(complete=True, busy=False, wal_frames=0, checkpointed=0, wal_bytes=0)
    await hk.run_once()
    assert hk.checkpoint_failures == 0
    async with sm() as s:
        assert len((await s.scalars(select(Activity).where(Activity.kind == "wal_checkpoint"))).all()) == 4


# ── recovery ─────────────────────────────────────────────────────────────────


def fan(peer_id="555"):
    return PeerInfo(peer_id=peer_id, username=f"fan{peer_id}", name="Fan", phone="+15557770000")


def ago(minutes):
    return (utcnow() - timedelta(minutes=minutes)).replace(microsecond=0)


@pytest.fixture
def directory():
    return FakeDirectory()


@pytest.fixture
def client(directory, settings, tmp_path, monkeypatch):
    monkeypatch.setattr(panel.recovery, "PEER_GAP_SEC", 0)
    app = create_app(settings, dist=tmp_path / "x", client_factory=directory.factory)
    with TestClient(app, base_url="https://panel.example.com") as c:
        set_password(c)
        speed_up_imports(c)
        c.post("/api/auth/login", json={"password": PASSWORD}, headers=H)
        yield c


def _recover(c, since, dry_run):
    r = c.post("/api/system/recover", json={"since": since.isoformat(), "dry_run": dry_run}, headers=H)
    assert r.status_code == 200, r.text
    for _ in range(200):
        job = c.get("/api/system/recover").json()["recovery"]
        if not job["running"]:
            return job
        time.sleep(0.02)
    raise AssertionError("recovery didn't finish")


def _disk_full(c, monkeypatch):
    """Make every message save fail the way it did on 2026-10-25."""

    async def full(*_a, **_k):
        raise sqlite3.OperationalError("database or disk is full")

    monkeypatch.setattr(c.app.state.service, "_report_chat", full)


def test_recovers_a_convo_lost_while_the_disk_was_full(client, directory, monkeypatch):
    first, reply = ago(120), ago(115)
    msgs = [
        IncomingMessage(fan(), 1, False, "text", "hi", first),
        IncomingMessage(fan(), 2, True, "text", "hey you", reply),
        IncomingMessage(fan(), 3, False, "text", "how are you", ago(110)),
    ]
    acc = _import(client, directory, 61, AccountInfo(8001, "megan", "+1", "M"), history={"555": msgs})

    # While the disk is full the messages arrive but nothing saves: no chat, no events.
    real = client.app.state.service._report_chat
    _disk_full(client, monkeypatch)
    for m in msgs:
        _deliver(client, acc, m)
    assert _convo(_outbox(client)) == []
    monkeypatch.setattr(client.app.state.service, "_report_chat", real)  # disk grown

    # Dry run: reports, changes nothing.
    job = _recover(client, ago(180), dry_run=True)
    assert job["totals"] == {"chats_scanned": 1, "messages_restored": 3, "first_events": 1, "reply_events": 1, "unanswered": 1}
    assert _convo(_outbox(client)) == []

    # Apply: the first and reply events are queued with Telegram's real times.
    job = _recover(client, ago(180), dry_run=False)
    assert job["totals"]["first_events"] == 1 and job["totals"]["reply_events"] == 1
    convo = _convo(_outbox(client))
    iso = lambda d: d.strftime("%Y-%m-%dT%H:%M:%SZ")  # noqa: E731
    assert convo[0] == {"tgAccount": "megan", "tgUserId": "8001", "peerId": "555", "peerPhone": "+15557770000", "firstMsgAt": iso(first)}
    assert convo[1]["repliedAt"] == iso(reply)

    async def _q():
        async with client.app.state.sessionmaker() as s:
            return len((await s.scalars(select(Message))).all()), (await s.scalars(select(Chat))).one()

    n_msgs, chat = client.portal.call(_q)
    assert n_msgs == 3  # the AI's history is back
    assert chat.reported_first and chat.reported_reply

    # Running it again changes nothing.
    job = _recover(client, ago(180), dry_run=False)
    assert (job["totals"]["first_events"], job["totals"]["reply_events"], job["totals"]["messages_restored"]) == (0, 0, 0)
    assert len(_convo(_outbox(client))) == 2


def test_only_the_missing_reply_is_queued(client, directory, monkeypatch):
    first, reply = ago(300), ago(100)
    msgs = [IncomingMessage(fan(), 1, False, "text", "hi", first), IncomingMessage(fan(), 2, True, "text", "hey", reply)]
    acc = _import(client, directory, 62, AccountInfo(8002, "olam", "+1", "O"), history={"555": msgs})
    _deliver(client, acc, msgs[0])  # saved before the outage → first event already queued
    real = client.app.state.service._report_chat
    _disk_full(client, monkeypatch)
    _deliver(client, acc, msgs[1])  # the reply arrives during it
    monkeypatch.setattr(client.app.state.service, "_report_chat", real)

    job = _recover(client, ago(200), dry_run=False)
    assert (job["totals"]["first_events"], job["totals"]["reply_events"]) == (0, 1)
    assert [("repliedAt" in p) for p in _convo(_outbox(client))] == [False, True]


def test_cold_outreach_is_not_a_convo_and_errors_are_per_account(client, directory):
    outreach = [IncomingMessage(fan("777"), 1, True, "text", "hey there", ago(30))]
    _import(client, directory, 63, AccountInfo(8003, "xomegy", "+1", "X"), history={"777": outreach})
    job = _recover(client, ago(60), dry_run=False)
    assert job["totals"]["chats_scanned"] == 1 and job["totals"]["first_events"] == 0
    assert _convo(_outbox(client)) == []


def test_a_failing_account_is_reported_and_others_continue(client, directory):
    _import(client, directory, 64, AccountInfo(8004, "broken", "+1", "B"), scan_error=TgError("limited", "Telegram asked to wait 600s", "FloodWaitError", retry_after=600))
    job = _recover(client, ago(60), dry_run=True)
    assert job["accounts"][0]["error"] == "Telegram asked to wait 600s"
    assert job["error"] is None


def test_recover_validates_since(client):
    assert client.post("/api/system/recover", json={"since": (utcnow() + timedelta(hours=1)).isoformat()}, headers=H).status_code == 400
    assert client.post("/api/system/recover", json={"since": (utcnow() - timedelta(days=8)).isoformat()}, headers=H).status_code == 400
    assert client.get("/api/system/recover").json() == {"recovery": None}


def test_status_shows_disk_usage(client):
    disk = client.get("/api/system/status").json()["disk"]
    assert disk["level"] in ("ok", "warn", "critical")
    assert set(disk["breakdown"]) == {"database", "database_wal", "ai_media", "avatars"}
    assert set(disk["housekeeping"]) == {"last_run_at", "last_result", "last_error", "last_checkpoint"}


def test_cli_disk_report(tmp_path, monkeypatch, capsys):
    from panel import __main__ as cli
    from panel.config import get_settings

    data = tmp_path / "d"
    data.mkdir()
    con = sqlite3.connect(data / "panel.db")
    for t in ("messages", "outbox", "activity", "chats", "leads", "import_items"):
        con.execute(f"CREATE TABLE {t} (id INTEGER)")
    con.commit()
    con.close()
    monkeypatch.setenv("DATA_DIR", str(data))
    monkeypatch.setenv("PANEL_ENC_KEY", "x")
    monkeypatch.setenv("PANEL_SECRET", "s" * 40)
    get_settings.cache_clear()
    try:
        assert cli.main(["panel", "disk"]) == 0
    finally:
        get_settings.cache_clear()
    out = capsys.readouterr().out
    assert "% used" in out and "rows messages" in out and Path(data).name in out
