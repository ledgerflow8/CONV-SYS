import os
import stat
from datetime import datetime

import pytest
from fastapi.testclient import TestClient

from panel.crypto import Crypto, InvalidToken, generate_key
from panel.lock import AlreadyRunning, InstanceLock
from panel.main import create_app
from panel.models import UTCDateTime
from tests.conftest import make_settings


def test_healthz_is_public_and_says_little(client):
    r = client.get("/healthz")
    assert r.status_code == 200
    assert r.json() == {"ok": True, "accounts_online": 0}


def test_security_headers(client):
    r = client.get("/healthz")
    assert r.headers["x-frame-options"] == "DENY"
    assert "default-src 'self'" in r.headers["content-security-policy"]
    assert client.get("/api/auth/me").headers["cache-control"] == "no-store"


def test_unknown_api_route_is_json_404(client):
    r = client.get("/api/nope")
    assert r.status_code == 404 and r.json() == {"detail": "Not found"}


def test_db_and_lock_are_owner_only(client, settings):
    assert stat.S_IMODE(os.stat(settings.db_path).st_mode) == 0o600
    assert stat.S_IMODE(os.stat(settings.lock_path).st_mode) == 0o600


def test_second_process_refuses_to_start(client, settings, tmp_path):
    with pytest.raises(AlreadyRunning):
        InstanceLock(settings.lock_path).acquire()
    second = create_app(settings, dist=tmp_path / "no-dist")
    with pytest.raises(AlreadyRunning):
        with TestClient(second):
            pass


def test_lock_released_on_shutdown(settings, tmp_path):
    with TestClient(create_app(settings, dist=tmp_path / "no-dist")):
        pass
    lock = InstanceLock(settings.lock_path)
    lock.acquire()
    lock.release()


def test_spa_fallback_serves_index_but_not_outside_dist(tmp_path):
    dist = tmp_path / "dist"
    (dist / "assets").mkdir(parents=True)
    (dist / "index.html").write_text("<html>panel</html>")
    (dist / "assets" / "app.js").write_text("console.log(1)")
    (tmp_path / "secret.txt").write_text("nope")
    with TestClient(create_app(make_settings(tmp_path), dist=dist)) as c:
        assert c.get("/accounts").text == "<html>panel</html>"
        assert c.get("/assets/app.js").text == "console.log(1)"
        assert "nope" not in c.get("/../secret.txt").text
        assert c.get("/api/nope").status_code == 404


def test_crypto_roundtrip_and_rotation():
    old, new = generate_key(), generate_key()
    token = Crypto(old).encrypt("1BVtsOK8Bu...session")
    assert b"session" not in token
    rotated = Crypto(f"{new},{old}")
    assert rotated.decrypt(token) == "1BVtsOK8Bu...session"
    assert Crypto(new).decrypt(rotated.rotate(token)) == "1BVtsOK8Bu...session"
    with pytest.raises(InvalidToken):
        Crypto(generate_key()).decrypt(token)


def test_bad_key_fails_at_startup(tmp_path):
    with pytest.raises(ValueError):
        create_app(make_settings(tmp_path).model_copy(update={"panel_enc_key": "not-a-key"}))


def test_naive_datetimes_are_refused():
    with pytest.raises(ValueError):
        UTCDateTime().process_bind_param(datetime(2026, 1, 1), None)
