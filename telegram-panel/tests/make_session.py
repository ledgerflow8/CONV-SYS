"""Build real .session file bytes (Telethon + Pyrogram SQLite) for the parser tests."""

import sqlite3
import tempfile
from pathlib import Path

from telethon.crypto import AuthKey
from telethon.sessions import StringSession

DC_ID = 2
ADDRESS = "149.154.167.51"


def string_session(key: bytes, dc_id: int = DC_ID, address: str = ADDRESS, port: int = 443) -> str:
    s = StringSession()
    s.set_dc(dc_id, address, port)
    s.auth_key = AuthKey(key)
    return s.save()


def _dump(build) -> bytes:
    with tempfile.TemporaryDirectory() as d:
        path = Path(d) / "s.session"
        conn = sqlite3.connect(path)
        try:
            build(conn)
            conn.commit()
        finally:
            conn.close()
        return path.read_bytes()


def telethon_session_bytes(key: bytes, dc_id: int = DC_ID, address: str = ADDRESS, port: int = 443) -> bytes:
    def build(conn):
        conn.execute(
            "CREATE TABLE sessions (dc_id integer primary key, server_address text, port integer, auth_key blob, takeout_id integer)"
        )
        conn.execute("INSERT INTO sessions VALUES (?,?,?,?,NULL)", (dc_id, address, port, key))

    return _dump(build)


def pyrogram_session_bytes(key: bytes, dc_id: int = DC_ID, user_id: int = 777, test_mode: int = 0, api_id: int = 123) -> bytes:
    def build(conn):
        conn.execute(
            "CREATE TABLE sessions (dc_id integer primary key, api_id integer, test_mode integer, "
            "auth_key blob, date integer not null, user_id integer, is_bot integer)"
        )
        conn.execute("INSERT INTO sessions VALUES (?,?,?,?,?,?,?)", (dc_id, api_id, test_mode, key, 0, user_id, 0))

    return _dump(build)


def key(seed: int = 1) -> bytes:
    return bytes(((seed + i) % 256 for i in range(256)))
