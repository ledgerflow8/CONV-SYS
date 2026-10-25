"""Disk housekeeping (PLAN.md §12). The data disk filled up once (2026-10-25) and every write failed
until it was resized; this keeps DATA_DIR bounded and makes the usage visible on Status.

What lives in DATA_DIR and how each part is kept in check:
- panel.db (+ -wal): message history, the portal outbox, the activity log. Old rows are pruned
  hourly; the WAL is checkpointed and truncated. Freed pages are reused by SQLite, so the file stops
  growing; "Compact database" on Status (VACUUM) shrinks it, at a quiet moment.
- ai_media/: fan media downloaded for Capitalbot and media fetched to send. Deleted after use; the
  sweep removes anything left behind (a crash, a failed download).
- avatars/: one small file per account. Orphans (deleted accounts) and oversized files are removed.
Telethon sessions are StringSessions held in panel.db (encrypted), so there are no session files.
"""

import asyncio
import logging
import os
import shutil
import time
from dataclasses import dataclass
from datetime import timedelta
from pathlib import Path

from sqlalchemy import bindparam, delete, select, text
from sqlalchemy.ext.asyncio import AsyncEngine, AsyncSession, async_sessionmaker

from panel.ai import HISTORY_MESSAGES
from panel.models import Account, Activity, ImportJob, OutboxItem, UTCDateTime, utcnow

log = logging.getLogger("panel.housekeeping")

INTERVAL_SEC = 3600
FIRST_RUN_DELAY_SEC = 60  # let startup (connecting every account) settle first
MESSAGE_KEEP_DAYS = 30  # older message rows go, except each chat's newest HISTORY_MESSAGES (the AI's context)
OUTBOX_SENT_KEEP_DAYS = 7  # delivered rows; pending rows are never pruned
OUTBOX_FAILED_KEEP_DAYS = 30
ACTIVITY_KEEP_DAYS = 30
IMPORT_KEEP_DAYS = 30
MEDIA_MAX_AGE_SEC = 30 * 60  # nothing in ai_media is in use for longer than one AI turn
AVATAR_MAX_BYTES = 2 * 1024 * 1024
BATCH = 5000

WAL_WARN_BYTES = 64 * 1024 * 1024  # = journal_size_limit: after a good checkpoint the WAL is far smaller
CHECKPOINT_ERROR_AFTER = 3  # failed hourly checkpoints in a row before the warning becomes an error

DISK_WARN_PCT = 80
DISK_CRITICAL_PCT = 90


@dataclass
class PruneResult:
    messages_deleted: int = 0
    messages_blanked: int = 0
    outbox_deleted: int = 0
    activity_deleted: int = 0
    imports_deleted: int = 0
    media_files_deleted: int = 0
    avatar_files_deleted: int = 0

    def total(self) -> int:
        return sum(vars(self).values())


def _size(path: Path) -> int:
    try:
        return path.stat().st_size
    except OSError:
        return 0


def _dir_size(path: Path) -> int:
    total = 0
    for root, _dirs, files in os.walk(path):
        for f in files:
            total += _size(Path(root) / f)
    return total


def disk_usage(data_dir: Path) -> dict:
    """The data disk's usage plus what the panel's own files take, for the Status screen."""
    du = shutil.disk_usage(data_dir)
    pct = round(du.used * 100 / du.total, 1) if du.total else 0.0
    db = data_dir / "panel.db"
    return {
        "total_bytes": du.total,
        "used_bytes": du.used,
        "free_bytes": du.free,
        "used_pct": pct,
        "level": "critical" if pct >= DISK_CRITICAL_PCT else "warn" if pct >= DISK_WARN_PCT else "ok",
        "breakdown": {
            "database": _size(db),
            "database_wal": _size(db.with_name(db.name + "-wal")),
            "ai_media": _dir_size(data_dir / "ai_media"),
            "avatars": _dir_size(data_dir / "avatars"),
        },
    }


def sweep_media(media_dir: Path, max_age_sec: float = MEDIA_MAX_AGE_SEC, now: float | None = None) -> int:
    """Delete files in ai_media older than max_age_sec (0 = everything, used at startup)."""
    if not media_dir.is_dir():
        return 0
    now = time.time() if now is None else now
    n = 0
    for f in media_dir.iterdir():
        try:
            if f.is_file() and now - f.stat().st_mtime >= max_age_sec:
                f.unlink()
                n += 1
        except OSError:
            continue
    return n


async def sweep_avatars(session: AsyncSession, avatar_dir: Path) -> int:
    """Delete avatar files with no account (deleted accounts) and any over AVATAR_MAX_BYTES."""
    if not avatar_dir.is_dir():
        return 0
    ids = {str(i) for i in (await session.scalars(select(Account.id))).all()}
    n = 0
    for f in avatar_dir.iterdir():
        try:
            if not f.is_file():
                continue
            if f.stem not in ids or f.stat().st_size > AVATAR_MAX_BYTES:
                f.unlink()
                n += 1
        except OSError:
            continue
    if n:
        # An account whose file went keeps showing a placeholder until its next avatar refresh.
        for acc in (await session.scalars(select(Account).where(Account.avatar_path.is_not(None)))).all():
            if not Path(acc.avatar_path).is_file():
                acc.avatar_path = None
    return n


# Rows beyond each chat's newest `keep`, older than the cutoff. Window functions need SQLite ≥ 3.25.
_OLD_MESSAGES = """
    SELECT id FROM (
        SELECT id, sender, at, text,
               ROW_NUMBER() OVER (PARTITION BY account_id, peer_id ORDER BY at DESC, id DESC) AS rn
        FROM messages
    ) WHERE rn > :keep AND at < :cutoff AND {cond}
    LIMIT :batch
"""


async def prune_messages(session: AsyncSession, keep_days: int = MESSAGE_KEEP_DAYS, keep_per_chat: int = HISTORY_MESSAGES) -> tuple[int, int]:
    """Fan and manual messages older than keep_days go, except each chat's newest keep_per_chat (the
    AI's history). AI messages keep their row (the all-time "AI replies" stat counts them) but lose
    their text. Returns (deleted, blanked)."""
    cutoff = utcnow() - timedelta(days=keep_days)
    params = {"keep": keep_per_chat, "cutoff": cutoff, "batch": BATCH}
    typed = [bindparam("cutoff", type_=UTCDateTime())]
    deleted = blanked = 0
    while True:
        ids = (await session.execute(text(_OLD_MESSAGES.format(cond="sender != 'ai'")).bindparams(*typed), params)).scalars().all()
        if not ids:
            break
        await session.execute(text("DELETE FROM messages WHERE id IN (" + ",".join(map(str, ids)) + ")"))
        await session.commit()
        deleted += len(ids)
    while True:
        ids = (
            await session.execute(text(_OLD_MESSAGES.format(cond="sender = 'ai' AND text IS NOT NULL")).bindparams(*typed), params)
        ).scalars().all()
        if not ids:
            break
        await session.execute(text("UPDATE messages SET text = NULL WHERE id IN (" + ",".join(map(str, ids)) + ")"))
        await session.commit()
        blanked += len(ids)
    return deleted, blanked


async def prune_rows(session: AsyncSession) -> tuple[int, int, int]:
    """Delivered/failed outbox rows, old activity and old import jobs. Pending outbox rows are kept."""
    now = utcnow()
    outbox = (
        await session.execute(
            delete(OutboxItem).where(
                ((OutboxItem.status == "sent") & (OutboxItem.created_at < now - timedelta(days=OUTBOX_SENT_KEEP_DAYS)))
                | ((OutboxItem.status == "failed") & (OutboxItem.created_at < now - timedelta(days=OUTBOX_FAILED_KEEP_DAYS)))
            )
        )
    ).rowcount
    activity = (await session.execute(delete(Activity).where(Activity.at < now - timedelta(days=ACTIVITY_KEEP_DAYS)))).rowcount
    imports = (await session.execute(delete(ImportJob).where(ImportJob.created_at < now - timedelta(days=IMPORT_KEEP_DAYS)))).rowcount
    await session.commit()
    return outbox or 0, activity or 0, imports or 0


@dataclass
class CheckpointResult:
    complete: bool  # every WAL frame folded into the database and the log reset to empty
    busy: bool  # a reader or writer kept it from finishing (within busy_timeout)
    wal_frames: int  # frames in the WAL when it ran
    checkpointed: int  # frames it managed to fold in
    wal_bytes: int  # WAL file size afterwards


async def checkpoint(engine: AsyncEngine) -> CheckpointResult:
    """Fold the WAL into the database and truncate it (journal_size_limit caps what's left).

    TRUNCATE waits (busy_timeout) for readers on the WAL to finish and holds new writers meanwhile, so
    it completes under constant traffic, unless a read stays open longer than that. Before 2026-10-25
    nothing ran it: SQLite's passive auto-checkpoint never found a quiet moment, and the WAL grew for
    days until the 1 GB disk filled. The result says whether it worked."""
    async with engine.connect() as conn:
        busy, frames, done = (await conn.exec_driver_sql("PRAGMA wal_checkpoint(TRUNCATE)")).one()
    db = Path(engine.url.database or "")
    wal_bytes = _size(db.with_name(db.name + "-wal")) if engine.url.database else 0
    return CheckpointResult(complete=busy == 0 and frames == done, busy=bool(busy), wal_frames=frames, checkpointed=done, wal_bytes=wal_bytes)


async def compact(engine: AsyncEngine, data_dir: Path) -> dict:
    """VACUUM: rewrite the database without its free pages. Needs free disk about the size of the
    database, and blocks writes while it runs, so it's a button on Status, not automatic."""
    db = data_dir / "panel.db"
    total = lambda: _size(db) + _size(db.with_name(db.name + "-wal"))  # noqa: E731
    before = total()
    if shutil.disk_usage(data_dir).free < before * 1.2 + 50 * 1024 * 1024:
        raise RuntimeError("Not enough free disk to compact the database safely. Free some space or grow the disk first.")
    await checkpoint(engine)
    async with engine.connect() as conn:
        conn = await conn.execution_options(isolation_level="AUTOCOMMIT")
        await conn.exec_driver_sql("VACUUM")
    await checkpoint(engine)
    return {"before_bytes": before, "after_bytes": total()}


class Housekeeper:
    def __init__(
        self,
        engine: AsyncEngine,
        sessionmaker: async_sessionmaker[AsyncSession],
        data_dir: Path,
        interval: float = INTERVAL_SEC,
        first_delay: float = FIRST_RUN_DELAY_SEC,
    ):
        self.engine = engine
        self.first_delay = first_delay
        self.sessionmaker = sessionmaker
        self.data_dir = data_dir
        self.interval = interval
        self.last_run_at = None
        self.last_result: PruneResult | None = None
        self.last_error: str | None = None
        self.last_checkpoint: CheckpointResult | None = None
        self.checkpoint_failures = 0  # in a row

    async def run(self) -> None:
        # Nothing is in flight at startup, so every leftover media file can go.
        sweep_media(self.data_dir / "ai_media", max_age_sec=0)
        # The DB passes wait: cancelling a task mid-query on aiosqlite can hang engine.dispose() at shutdown.
        await asyncio.sleep(self.first_delay)
        while True:
            try:
                await self.run_once()
            except asyncio.CancelledError:
                raise
            except Exception as e:
                self.last_error = f"{type(e).__name__}: {e}"[:300]
                log.exception("housekeeping failed")
            await asyncio.sleep(self.interval)

    async def run_once(self) -> PruneResult:
        r = PruneResult()
        r.media_files_deleted = sweep_media(self.data_dir / "ai_media")
        async with self.sessionmaker() as session:
            r.messages_deleted, r.messages_blanked = await prune_messages(session)
            r.outbox_deleted, r.activity_deleted, r.imports_deleted = await prune_rows(session)
            r.avatar_files_deleted = await sweep_avatars(session, self.data_dir / "avatars")
            usage = disk_usage(self.data_dir)
            if usage["level"] != "ok":
                session.add(
                    Activity(
                        level="error" if usage["level"] == "critical" else "warn",
                        kind="disk_high",
                        message=f"Data disk is {usage['used_pct']}% full ({usage['free_bytes'] // (1024 * 1024)} MB free). Grow the disk on Render.",
                    )
                )
            await session.commit()
        await self._checkpoint()
        self.last_run_at, self.last_result, self.last_error = utcnow(), r, None
        if r.total():
            log.info("housekeeping: %s", vars(r))
        return r

    async def _checkpoint(self) -> CheckpointResult:
        """Hourly checkpoint; a failed one (or a WAL still over the cap) goes to the activity log."""
        cp = await checkpoint(self.engine)
        self.last_checkpoint = cp
        if cp.complete and cp.wal_bytes <= WAL_WARN_BYTES:
            self.checkpoint_failures = 0
            return cp
        self.checkpoint_failures += 1
        mb = cp.wal_bytes / (1024 * 1024)
        why = "the database was busy" if cp.busy else f"only {cp.checkpointed} of {cp.wal_frames} pages were folded in"
        level = "error" if self.checkpoint_failures >= CHECKPOINT_ERROR_AFTER else "warn"
        msg = (
            f"Database log (WAL) couldn't be folded into the database: {why}. It's {mb:,.1f} MB"
            f" ({self.checkpoint_failures} hourly attempt{'s' if self.checkpoint_failures > 1 else ''} in a row)."
            " If this keeps happening it grows until the disk fills; check Status → Data disk."
        )
        log.warning(msg)
        async with self.sessionmaker() as session:
            session.add(Activity(level=level, kind="wal_checkpoint", message=msg))
            await session.commit()
        return cp
