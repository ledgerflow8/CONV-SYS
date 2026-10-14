import pytest

from panel.tg.sessions import SessionFileError, key_sha256_of, parse_session
from tests.make_session import key, pyrogram_session_bytes, string_session, telethon_session_bytes


def test_parse_telethon_roundtrips_to_string_and_key_hash():
    k = key(5)
    parsed = parse_session(telethon_session_bytes(k))
    assert parsed.format == "telethon"
    assert parsed.string == string_session(k)
    assert parsed.key_sha256 == key_sha256_of(parsed.string)
    assert parsed.user_id is None


def test_parse_pyrogram_maps_dc_to_address_and_keeps_user_id():
    k = key(9)
    parsed = parse_session(pyrogram_session_bytes(k, dc_id=2, user_id=4242))
    assert parsed.format == "pyrogram"
    assert parsed.user_id == 4242
    # Same auth key → same Telethon string and hash as a Telethon file for DC 2.
    assert parsed.string == string_session(k, dc_id=2)


def test_same_key_two_formats_same_hash():
    k = key(1)
    assert parse_session(telethon_session_bytes(k)).key_sha256 == parse_session(pyrogram_session_bytes(k)).key_sha256


@pytest.mark.parametrize(
    "data, msg",
    [
        (b"not sqlite at all", "not a session file"),
        (b"SQLite format 3\x00" + b"\x00" * 100, "corrupt"),
    ],
)
def test_rejects_non_session(data, msg):
    with pytest.raises(SessionFileError) as e:
        parse_session(data)
    assert msg in str(e.value)


def test_rejects_pyrogram_test_mode():
    with pytest.raises(SessionFileError, match="test-server"):
        parse_session(pyrogram_session_bytes(key(), test_mode=1))


def test_rejects_empty_session():
    # A telethon table with no auth_key row.
    import sqlite3
    import tempfile
    from pathlib import Path

    with tempfile.TemporaryDirectory() as d:
        p = Path(d) / "s.session"
        c = sqlite3.connect(p)
        c.execute("CREATE TABLE sessions (dc_id integer primary key, server_address text, port integer, auth_key blob)")
        c.commit()
        c.close()
        data = p.read_bytes()
    with pytest.raises(SessionFileError, match="empty"):
        parse_session(data)
