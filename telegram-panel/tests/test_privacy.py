"""Privacy settings + clean-profile, per account and in bulk, and the online defaults applied on
import (client feedback 2026-10-31)."""

import pytest
from fastapi.testclient import TestClient

from panel.main import create_app
from tests.conftest import H, PASSWORD, set_password, speed_up_imports
from tests.fake_tg import FakeDirectory
from tests.test_ai import run, setup


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


def _fake(client, acc):
    return client.app.state.service.manager.get(acc)


# ── privacy ───────────────────────────────────────────────────────────────────
def test_import_applies_online_privacy_defaults(client, directory):
    acc = setup(client, directory, 60, 6000, "a")
    assert {"last_seen": "everybody", "profile_photo": "everybody"} in _fake(client, acc).privacy_set


def test_get_and_set_privacy(client, directory):
    acc = setup(client, directory, 61, 6001, "b")
    cur = client.get(f"/api/accounts/{acc}/privacy", headers=H).json()["privacy"]
    assert cur["last_seen"] == "everybody" and cur["profile_photo"] == "everybody"
    r = client.post(f"/api/accounts/{acc}/privacy", json={"rules": {"phone": "nobody", "forwards": "contacts"}}, headers=H)
    assert r.status_code == 200
    assert {"phone": "nobody", "forwards": "contacts"} in _fake(client, acc).privacy_set
    assert r.json()["privacy"]["phone"] == "nobody"


def test_set_privacy_rejects_unknown(client, directory):
    acc = setup(client, directory, 62, 6002, "c")
    assert client.post(f"/api/accounts/{acc}/privacy", json={"rules": {"bogus": "everybody"}}, headers=H).status_code == 400
    assert client.post(f"/api/accounts/{acc}/privacy", json={"rules": {"phone": "someone"}}, headers=H).status_code == 400
    assert client.post(f"/api/accounts/{acc}/privacy", json={"rules": {}}, headers=H).status_code == 400


def test_bulk_privacy_apply_to_all(client, directory):
    a1 = setup(client, directory, 63, 6003, "d")
    a2 = setup(client, directory, 64, 6004, "e")
    r = client.post("/api/accounts/bulk/privacy", json={"all": True, "rules": {"phone": "nobody"}}, headers=H)
    assert r.status_code == 200 and all(x["ok"] for x in r.json()["results"])
    assert {"phone": "nobody"} in _fake(client, a1).privacy_set
    assert {"phone": "nobody"} in _fake(client, a2).privacy_set


# ── clean profile ───────────────────────────────────────────────────────────
def test_clean_profile_deletes_stories_and_music(client, directory):
    acc = setup(client, directory, 65, 6005, "f", stories=[1, 2, 3], music=[10, 20])
    r = client.post(f"/api/accounts/{acc}/clean-profile", headers=H).json()
    assert r == {"ok": True, "stories_deleted": 3, "music_removed": 2}
    f = _fake(client, acc)
    assert f.stories_deleted == 3 and f.music_removed == 2
    assert f._fake.stories == [] and f._fake.music == []


def test_bulk_clean_profile_by_ids(client, directory):
    a1 = setup(client, directory, 66, 6006, "g", stories=[1], music=[])
    a2 = setup(client, directory, 67, 6007, "h", stories=[1, 2], music=[9])
    r = client.post("/api/accounts/bulk/clean-profile", json={"account_ids": [a1, a2]}, headers=H)
    assert all(x["ok"] for x in r.json()["results"])
    assert _fake(client, a1).stories_deleted == 1
    assert _fake(client, a2).stories_deleted == 2 and _fake(client, a2).music_removed == 1
