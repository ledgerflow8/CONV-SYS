from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from panel.auth import store_password
from panel.config import Settings
from panel.crypto import generate_key
from panel.main import create_app

PASSWORD = "correct horse battery"
H = {"X-Panel": "1"}


def make_settings(tmp_path: Path, **kw) -> Settings:
    # A panel Telegram app is set by default (as on the VPS). Pass tg_api_id=None to drop it.
    kw.setdefault("tg_api_id", 999999)
    kw.setdefault("tg_api_hash", "f" * 32)
    return Settings(
        panel_enc_key=generate_key(),
        panel_secret="s" * 40,
        data_dir=tmp_path / "data",
        public_origin="https://panel.example.com",
        _env_file=None,
        **kw,
    )


@pytest.fixture
def settings(tmp_path: Path) -> Settings:
    return make_settings(tmp_path)


@pytest.fixture
def client(settings: Settings, tmp_path: Path):
    app = create_app(settings, dist=tmp_path / "no-dist")
    with TestClient(app, base_url="https://panel.example.com") as c:
        yield c


def speed_up_imports(client: TestClient) -> None:
    client.app.state.service.import_gap_seconds = 0


def set_password(client: TestClient, password: str = PASSWORD) -> None:
    async def _set():
        async with client.app.state.sessionmaker() as s:
            await store_password(s, password)
            await s.commit()

    client.portal.call(_set)


def login(client: TestClient, password: str = PASSWORD):
    return client.post("/api/auth/login", json={"password": password}, headers=H)
