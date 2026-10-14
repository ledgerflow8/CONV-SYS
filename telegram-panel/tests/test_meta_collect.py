import io
import json
import zipfile

import pytest

from panel.collect import TooLarge, collect
from panel.tg.meta import parse_meta
from tests.make_session import key, telethon_session_bytes


def test_meta_accepts_varied_key_spellings():
    m = parse_meta(
        {
            "app_id": "123456",
            "app_hash": "a" * 32,
            "device": "iPhone 14",
            "sdk": "iOS 17.0",
            "app_version": "9.0",
            "twoFA": "hunter2",
            "lang_pack": "en",
            "proxy": [2, "1.2.3.4", "1080", 0, "u", "p"],
            "phone": "1 (555) 123-4567",
        }
    )
    assert m.api_id == 123456
    assert m.api_hash == "a" * 32
    assert m.device_model == "iPhone 14"
    assert m.twofa == "hunter2"
    assert m.proxy == {"type": "socks5", "host": "1.2.3.4", "port": 1080, "user": "u", "password": "p"}
    assert m.phone == "+15551234567"


def test_meta_drops_bad_api_hash_and_missing_fields():
    m = parse_meta({"api_id": "nope", "api_hash": "short"})
    assert m.api_id is None and m.api_hash is None


def test_meta_rejects_non_object():
    with pytest.raises(ValueError):
        parse_meta([1, 2, 3])


def _zip(files: dict[str, bytes]) -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        for name, data in files.items():
            zf.writestr(name, data)
    return buf.getvalue()


def test_collect_pairs_session_and_json():
    sess = telethon_session_bytes(key(1))
    meta = json.dumps({"app_id": 1, "app_hash": "b" * 32}).encode()
    got = collect([("123.session", sess), ("123.json", meta)])
    assert len(got.candidates) == 1
    c = got.candidates[0]
    assert c.session == sess and c.meta["app_id"] == 1
    assert not got.invalid


def test_collect_json_without_session_is_invalid():
    got = collect([("orphan.json", b"{}")])
    assert not got.candidates
    assert got.invalid == [("orphan.json", "no .session file with the same name")]


def test_collect_bad_json_keeps_session_with_error():
    got = collect([("a.session", telethon_session_bytes(key(2))), ("a.json", b"{not json")])
    assert len(got.candidates) == 1
    assert got.candidates[0].meta_error


def test_collect_unzips_and_pairs_by_folder(tmp_path):
    sess = telethon_session_bytes(key(3))
    z = _zip({"batch/1.session": sess, "batch/1.json": b'{"app_id": 7, "app_hash": "' + b"c" * 32 + b'"}', "readme.txt": b"hi"})
    got = collect([("upload.zip", z)])
    assert len(got.candidates) == 1
    assert got.candidates[0].meta["app_id"] == 7
    assert got.candidates[0].name == "upload/batch/1.session"


def test_collect_skips_macosx_and_dotfiles():
    z = _zip({"__MACOSX/._1.session": b"junk", ".hidden/1.session": b"junk", "1.session": telethon_session_bytes(key(4))})
    got = collect([("u.zip", z)])
    assert len(got.candidates) == 1
    assert got.candidates[0].name == "u/1.session"


def test_collect_rejects_oversized_zip_entry():
    z = _zip({"big.session": b"x" * (21 * 1024 * 1024)})
    with pytest.raises(TooLarge):
        collect([("u.zip", z)])


def test_collect_nested_zip_is_invalid():
    inner = _zip({"a.session": telethon_session_bytes(key(5))})
    outer = _zip({"inner.zip": inner})
    got = collect([("outer.zip", outer)])
    assert any("zips inside zips" in r for _, r in got.invalid)
