"""An in-memory stand-in for the Telethon wrapper, so the panel's logic runs without Telegram.

A test builds a FakeDirectory of what each session string resolves to, then passes
`fakes.factory` as the app's client_factory.
"""

import asyncio
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path

from panel.tg.client import AccountInfo, ConnectParams, TgError


@dataclass
class FakeAccount:
    info: AccountInfo
    error: TgError | None = None  # raised on start() instead of returning info
    has_avatar: bool = True
    last_msg_at: datetime | None = None
    last_incoming_at: datetime | None = None


class FakeClient:
    def __init__(self, directory: "FakeDirectory", params: ConnectParams):
        self._dir = directory
        self._params = params
        self._fake = directory.by_session.get(params.session)
        self._disconnected: asyncio.Future = asyncio.get_event_loop().create_future()
        self.logged_out = False

    async def start(self) -> AccountInfo:
        self._dir.started.append(self._params.session)
        if self._fake is None:
            raise TgError("revoked", "Session isn't logged in")
        if self._fake.error:
            raise self._fake.error
        return self._fake.info

    async def disconnect(self) -> None:
        if not self._disconnected.done():
            self._disconnected.set_result(None)

    async def log_out(self) -> None:
        self.logged_out = True
        self._dir.logged_out.append(self._fake.info.user_id if self._fake else None)

    async def download_avatar(self, path: Path) -> bool:
        if self._fake and self._fake.has_avatar:
            Path(path).write_bytes(b"\xff\xd8\xff\xe0jpeg")
            return True
        return False

    async def last_activity(self):
        return (self._fake.last_msg_at, self._fake.last_incoming_at) if self._fake else (None, None)

    async def wait_disconnected(self):
        await self._disconnected
        return None

    def session_string(self) -> str:
        return self._params.session

    def on_private_message(self, cb) -> None:
        self._cb = cb


class FakeDirectory:
    def __init__(self):
        self.by_session: dict[str, FakeAccount] = {}
        self.started: list[str] = []
        self.logged_out: list[int] = []
        self.clients: list[FakeClient] = []

    def add(self, session: str, fake: FakeAccount) -> None:
        self.by_session[session] = fake

    def factory(self, params: ConnectParams) -> FakeClient:
        c = FakeClient(self, params)
        self.clients.append(c)
        return c
