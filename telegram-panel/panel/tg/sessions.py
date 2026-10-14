"""Reads uploaded .session files (Telethon or Pyrogram SQLite) into a Telethon StringSession.

The file is loaded straight into an in-memory SQLite database (`deserialize`), so nothing
is ever written to disk.
"""

import hashlib
import ipaddress
import sqlite3
from dataclasses import dataclass

from telethon.crypto import AuthKey
from telethon.sessions import StringSession

# Telegram production DCs (what Pyrogram assumes; its files don't store addresses).
DC_ADDRESSES = {
    1: "149.154.175.53",
    2: "149.154.167.51",
    3: "149.154.175.100",
    4: "149.154.167.91",
    5: "91.108.56.130",
}
MAX_SESSION_BYTES = 10 * 1024 * 1024


class SessionFileError(ValueError):
    pass


@dataclass(frozen=True)
class ParsedSession:
    format: str  # telethon · pyrogram
    string: str  # Telethon StringSession
    key_sha256: str  # duplicate detection without connecting
    user_id: int | None  # Pyrogram stores it; Telethon doesn't


def _columns(conn: sqlite3.Connection, table: str) -> set[str]:
    return {row[1] for row in conn.execute(f"PRAGMA table_info({table})")}


def _to_string(dc_id: int, address: str, port: int, key: bytes) -> str:
    if len(key) != 256:
        raise SessionFileError("auth key has the wrong length")
    try:
        ipaddress.ip_address(address)
    except ValueError:
        raise SessionFileError("server address isn't an IP") from None
    s = StringSession()
    s.set_dc(dc_id, address, port)
    s.auth_key = AuthKey(key)
    return s.save()


def parse_session(data: bytes) -> ParsedSession:
    if len(data) > MAX_SESSION_BYTES:
        raise SessionFileError("file is too large to be a session")
    if not data.startswith(b"SQLite format 3\x00"):
        raise SessionFileError("not a session file (tdata and string sessions aren't supported)")

    conn = sqlite3.connect(":memory:")
    try:
        try:
            conn.deserialize(data)
            tables = {r[0] for r in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        except sqlite3.DatabaseError:
            raise SessionFileError("session file is corrupt") from None
        if "sessions" not in tables:
            raise SessionFileError("no sessions table")
        cols = _columns(conn, "sessions")

        if {"dc_id", "server_address", "port", "auth_key"} <= cols:
            row = conn.execute("SELECT dc_id, server_address, port, auth_key FROM sessions WHERE auth_key IS NOT NULL").fetchone()
            if not row:
                raise SessionFileError("session is empty (never logged in)")
            dc_id, address, port, key = row
            fmt, user_id = "telethon", None
        elif {"dc_id", "auth_key", "test_mode"} <= cols:
            has_user = "user_id" in cols
            row = conn.execute(
                f"SELECT dc_id, auth_key, test_mode, {'user_id' if has_user else 'NULL'} FROM sessions WHERE auth_key IS NOT NULL"
            ).fetchone()
            if not row:
                raise SessionFileError("session is empty (never logged in)")
            dc_id, key, test_mode, user_id = row
            if test_mode:
                raise SessionFileError("test-server session")
            if dc_id not in DC_ADDRESSES:
                raise SessionFileError(f"unknown DC {dc_id}")
            address, port, fmt = DC_ADDRESSES[dc_id], 443, "pyrogram"
        else:
            raise SessionFileError("unknown session format")
    except sqlite3.DatabaseError:
        raise SessionFileError("session file is corrupt") from None
    finally:
        conn.close()

    if not isinstance(key, bytes):
        raise SessionFileError("auth key is missing")
    return ParsedSession(
        format=fmt,
        string=_to_string(int(dc_id), str(address), int(port), key),
        key_sha256=hashlib.sha256(key).hexdigest(),
        user_id=int(user_id) if user_id else None,
    )


def key_sha256_of(string_session: str) -> str:
    return hashlib.sha256(StringSession(string_session).auth_key.key).hexdigest()
