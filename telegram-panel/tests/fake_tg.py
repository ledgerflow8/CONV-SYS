"""An in-memory stand-in for the Telethon wrapper, so the panel's logic runs without Telegram.

A test builds a FakeDirectory of what each session string resolves to, then passes
`fakes.factory` as the app's client_factory.
"""

import asyncio
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path

from panel.tg.client import AccountInfo, ChatScan, ConnectParams, IncomingMessage, ProfileInfo, TgError


@dataclass
class FakeAccount:
    info: AccountInfo
    error: TgError | None = None  # raised on start() instead of returning info
    has_avatar: bool = True
    last_msg_at: datetime | None = None
    last_incoming_at: datetime | None = None
    # (first_in, first_reply) a dialog_firsts() lookup returns, keyed by peer id string.
    dialog_firsts: dict[str, tuple[datetime | None, datetime | None]] = field(default_factory=dict)
    # fan media available to download_message_media(), keyed by (peer_id str, tg_msg_id) → bytes.
    media: dict[tuple[str, int], bytes] = field(default_factory=dict)
    # profile editing
    last_name: str | None = None
    about: str | None = None
    username_floodwait: int | None = None  # when set, check_username raises a FloodWait (limited)
    # Full Telegram history per fan (peer id str → messages oldest first), for recovery scans.
    history: dict[str, list[IncomingMessage]] = field(default_factory=dict)
    scan_error: TgError | None = None  # raised by recent_peers (e.g. a long FloodWait)


class FakeClient:
    def __init__(self, directory: "FakeDirectory", params: ConnectParams):
        self._dir = directory
        self._params = params
        self._fake = directory.by_session.get(params.session)
        self._disconnected: asyncio.Future = asyncio.get_event_loop().create_future()
        self._drop_err: TgError | None = None
        self.logged_out = False
        self.sent: list[dict] = []  # what the AI worker sent through this client
        self.read_marked = 0
        self._next_id = 10_000
        self.profile_update: dict | None = None  # last update_profile(first, last, about)
        self.username_set: str | None = None
        self.photo_set: str | None = None
        self.photo_deleted = False

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

    async def dialog_firsts(self, peer_id: int):
        if self._fake:
            return self._fake.dialog_firsts.get(str(peer_id), (None, None))
        return (None, None)

    async def wait_disconnected(self):
        await self._disconnected
        return self._drop_err

    async def drop(self, err: TgError | None = None) -> None:
        """Test helper: simulate the live connection dropping on its own (optionally with an error),
        the way Telethon would on a ban, a network loss, or an unreadable update."""
        self._drop_err = err
        if not self._disconnected.done():
            self._disconnected.set_result(None)

    def session_string(self) -> str:
        return self._params.session

    # ── sending (step 3) ──────────────────────────────────────────────────────
    async def send_text(self, peer_id: int, text: str) -> int:
        self._next_id += 1
        self.sent.append({"peer": peer_id, "type": "text", "text": text, "id": self._next_id})
        return self._next_id

    async def send_file(self, peer_id: int, path: str, *, voice: bool = False) -> int:
        self._next_id += 1
        self.sent.append({"peer": peer_id, "type": "voice" if voice else "file", "path": path, "id": self._next_id})
        return self._next_id

    async def mark_read(self, peer_id: int) -> None:
        self.read_marked += 1

    async def typing(self, peer_id: int, seconds: float) -> None:
        return  # instant in tests

    async def download_message_media(self, peer_id: int, tg_msg_id: int, dest_dir: Path):
        data = self._fake.media.get((str(peer_id), tg_msg_id)) if self._fake else None
        if data is None:
            return None
        Path(dest_dir).mkdir(parents=True, exist_ok=True)
        p = Path(dest_dir) / f"{peer_id}_{tg_msg_id}.jpg"
        p.write_bytes(data)
        return p

    # ── recovery ───────────────────────────────────────────────────────────────
    async def recent_peers(self, since: datetime):
        if self._fake.scan_error:
            raise self._fake.scan_error
        chats = [msgs for msgs in self._fake.history.values() if msgs and msgs[-1].at >= since]
        chats.sort(key=lambda msgs: msgs[-1].at, reverse=True)
        return [msgs[-1].peer for msgs in chats]

    async def scan_chat(self, peer_id: int, since: datetime) -> ChatScan:
        msgs = self._fake.history[str(peer_id)]
        first_in = next((m.at for m in msgs if not m.out), None)
        first_reply = next((m.at for m in msgs if m.out and first_in is not None and m.at >= first_in), None)
        return ChatScan(peer=msgs[-1].peer, first_in=first_in, first_reply=first_reply, recent=[m for m in msgs if m.at >= since])

    # ── profile editing ────────────────────────────────────────────────────────
    async def get_profile(self) -> ProfileInfo:
        info = self._fake.info
        return ProfileInfo(first_name=info.first_name, last_name=self._fake.last_name, about=self._fake.about, username=info.username)

    async def check_username(self, username: str) -> bool:
        if self._fake and self._fake.username_floodwait:
            raise TgError("limited", f"Telegram asked to wait {self._fake.username_floodwait}s", "FloodWaitError", retry_after=self._fake.username_floodwait)
        return username.lower() not in self._dir.taken_usernames

    async def update_profile(self, first_name: str, last_name: str, about: str) -> None:
        self.profile_update = {"first_name": first_name, "last_name": last_name, "about": about}
        if self._fake:
            self._fake.last_name, self._fake.about = last_name, about

    async def set_username(self, username: str) -> None:
        if username.lower() in self._dir.taken_usernames:
            raise TgError("username_taken", "That username is already taken.", "UsernameOccupiedError")
        self.username_set = username

    async def set_profile_photo(self, path: str) -> None:
        self.photo_set = path
        if self._fake:
            self._fake.has_avatar = True

    async def delete_profile_photo(self) -> None:
        self.photo_deleted = True
        if self._fake:
            self._fake.has_avatar = False

    def on_private_message(self, cb) -> None:
        self._cb = cb

    async def deliver(self, msg: IncomingMessage) -> None:
        """Test helper: push a message as if Telegram delivered it to this account."""
        await self._cb(msg)


class FakeDirectory:
    def __init__(self):
        self.by_session: dict[str, FakeAccount] = {}
        self.started: list[str] = []
        self.logged_out: list[int] = []
        self.clients: list[FakeClient] = []
        self.taken_usernames: set[str] = set()  # usernames CheckUsername/UpdateUsername report as taken

    def add(self, session: str, fake: FakeAccount) -> None:
        self.by_session[session] = fake

    def factory(self, params: ConnectParams) -> FakeClient:
        c = FakeClient(self, params)
        self.clients.append(c)
        return c
