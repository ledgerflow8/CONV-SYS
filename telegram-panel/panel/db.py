"""SQLite (WAL) through SQLAlchemy async, plus key/value settings helpers."""

from pathlib import Path
from typing import Any

from sqlalchemy import event, select
from sqlalchemy.ext.asyncio import AsyncEngine, AsyncSession, async_sessionmaker, create_async_engine

from panel.models import Base, Setting


def make_engine(db_path: Path) -> AsyncEngine:
    db_path.parent.mkdir(parents=True, exist_ok=True)
    engine = create_async_engine(f"sqlite+aiosqlite:///{db_path}")

    @event.listens_for(engine.sync_engine, "connect")
    def _pragmas(conn: Any, _record: Any) -> None:
        cur = conn.cursor()
        cur.execute("PRAGMA journal_mode=WAL")
        cur.execute("PRAGMA foreign_keys=ON")
        cur.execute("PRAGMA busy_timeout=5000")
        # After each checkpoint, truncate the WAL back to at most 64 MB instead of leaving it at its peak.
        cur.execute("PRAGMA journal_size_limit=67108864")
        cur.close()

    return engine


def _add_missing_columns(conn: Any) -> None:
    """Additive, idempotent column migrations for tables that already hold real data — create_all
    never alters an existing table (CLAUDE.md). SQLite ADD COLUMN is cheap and safe for a nullable."""
    migrations = {
        "chats": {"access_hash": "ALTER TABLE chats ADD COLUMN access_hash BIGINT"},
    }
    for table, cols in migrations.items():
        existing = {row[1] for row in conn.exec_driver_sql(f"PRAGMA table_info({table})").fetchall()}
        for name, ddl in cols.items():
            if name not in existing:
                conn.exec_driver_sql(ddl)


async def init_db(engine: AsyncEngine) -> None:
    # The DB holds encrypted sessions: keep it owner-only.
    path = engine.url.database
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
        await conn.run_sync(_add_missing_columns)
    if path:
        Path(path).chmod(0o600)


def make_sessionmaker(engine: AsyncEngine) -> async_sessionmaker[AsyncSession]:
    return async_sessionmaker(engine, expire_on_commit=False)


async def get_setting(session: AsyncSession, key: str, default: Any = None) -> Any:
    row = await session.scalar(select(Setting).where(Setting.key == key))
    return row.value if row else default


async def set_setting(session: AsyncSession, key: str, value: Any) -> None:
    row = await session.get(Setting, key)
    if row:
        row.value = value
    else:
        session.add(Setting(key=key, value=value))
