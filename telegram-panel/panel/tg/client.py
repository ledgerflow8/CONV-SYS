"""The only module that talks to Telethon. Everything else sees `TgClient`, `AccountInfo` and
`TgError`, so the panel's logic runs against a fake in tests."""

import asyncio
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Protocol

from telethon import TelegramClient, errors, events, functions, types
from telethon.sessions import StringSession

TELEGRAM_SERVICE_ID = 777000  # login codes etc.; never a fan

DEFAULT_DEVICE = {
    "device_model": "Desktop",
    "system_version": "Windows 10",
    "app_version": "5.6.3 x64",
    "lang_code": "en",
    "system_lang_code": "en-US",
}


@dataclass(frozen=True)
class AccountInfo:
    user_id: int
    username: str | None  # lowercase, no @
    phone: str | None  # E.164 with +
    first_name: str | None


@dataclass(frozen=True)
class ConnectParams:
    session: str  # Telethon StringSession
    api_id: int
    api_hash: str
    device_model: str | None = None
    system_version: str | None = None
    app_version: str | None = None
    lang_code: str | None = None
    system_lang_code: str | None = None


class TgError(Exception):
    """A Telegram failure mapped to an account status."""

    def __init__(self, status: str, detail: str):
        super().__init__(detail)
        self.status = status  # revoked · banned · limited · error
        self.detail = detail

    @property
    def dead(self) -> bool:
        return self.status in ("revoked", "banned")


def classify(e: BaseException) -> TgError:
    if isinstance(e, TgError):
        return e
    if isinstance(e, errors.AuthKeyDuplicatedError):
        return TgError("revoked", "Session was used from two places at once and Telegram ended it")
    if isinstance(e, (errors.UserDeactivatedBanError, errors.PhoneNumberBannedError)):
        return TgError("banned", "Account is banned by Telegram")
    if isinstance(e, errors.UserDeactivatedError):
        return TgError("banned", "Account was deleted or deactivated")
    if isinstance(e, (errors.AuthKeyUnregisteredError, errors.SessionRevokedError, errors.SessionExpiredError)):
        return TgError("revoked", "Session was logged out or revoked")
    if isinstance(e, (errors.UnauthorizedError, errors.AuthKeyError)):
        return TgError("revoked", f"Session isn't authorised ({type(e).__name__})")
    if isinstance(e, errors.FloodWaitError):
        return TgError("limited", f"Telegram asked to wait {e.seconds}s")
    if isinstance(e, (asyncio.TimeoutError, ConnectionError, OSError)):
        return TgError("error", "Couldn't reach Telegram")
    return TgError("error", f"{type(e).__name__}: {e}"[:300])


MessageCallback = Callable[[bool, datetime], Awaitable[None]]  # (incoming, at)


class TgClient(Protocol):
    async def start(self) -> AccountInfo: ...
    async def disconnect(self) -> None: ...
    async def log_out(self) -> None: ...
    async def download_avatar(self, path: Path) -> bool: ...
    async def last_activity(self) -> tuple[datetime | None, datetime | None]: ...
    async def wait_disconnected(self) -> TgError | None: ...
    def session_string(self) -> str: ...
    def on_private_message(self, cb: MessageCallback) -> None: ...


ClientFactory = Callable[[ConnectParams], TgClient]


def _is_fan(user: object) -> bool:
    return isinstance(user, types.User) and not user.bot and not user.is_self and user.id != TELEGRAM_SERVICE_ID


def _info(me: types.User) -> AccountInfo:
    username = me.username
    if not username and me.usernames:
        username = next((u.username for u in me.usernames if u.active), None)
    return AccountInfo(
        user_id=me.id,
        username=username.lower() if username else None,
        phone=f"+{me.phone}" if me.phone else None,
        first_name=me.first_name,
    )


class TelethonClient:
    CONNECT_TIMEOUT = 25

    def __init__(self, p: ConnectParams):
        d = DEFAULT_DEVICE
        self._c = TelegramClient(
            StringSession(p.session),
            p.api_id,
            p.api_hash,
            device_model=p.device_model or d["device_model"],
            system_version=p.system_version or d["system_version"],
            app_version=p.app_version or d["app_version"],
            lang_code=p.lang_code or d["lang_code"],
            system_lang_code=p.system_lang_code or d["system_lang_code"],
            connection_retries=3,
            retry_delay=2,
            timeout=10,
            flood_sleep_threshold=0,
        )

    async def start(self) -> AccountInfo:
        try:
            await asyncio.wait_for(self._c.connect(), self.CONNECT_TIMEOUT)
            # Raw call: get_me() swallows auth errors, and we need them to tell banned from revoked.
            users = await asyncio.wait_for(self._c(functions.users.GetUsersRequest([types.InputUserSelf()])), 15)
            if not users or not isinstance(users[0], types.User):
                raise TgError("revoked", "Session isn't logged in")
            return _info(users[0])
        except BaseException as e:
            await self.disconnect()
            if isinstance(e, asyncio.CancelledError):
                raise
            raise classify(e) from e

    async def disconnect(self) -> None:
        try:
            await self._c.disconnect()
        except Exception:
            pass

    async def log_out(self) -> None:
        try:
            ok = await self._c.log_out()
        except Exception as e:
            raise classify(e) from e
        if not ok:
            raise TgError("error", "Telegram didn't confirm the log out")

    async def download_avatar(self, path: Path) -> bool:
        try:
            got = await self._c.download_profile_photo("me", file=str(path), download_big=False)
        except Exception:
            return False
        return bool(got)

    async def last_activity(self) -> tuple[datetime | None, datetime | None]:
        """(last message, last incoming message) from the newest DM with a real user."""
        try:
            async for d in self._c.iter_dialogs(limit=30):
                if d.is_user and _is_fan(d.entity) and d.message:
                    return d.message.date, (None if d.message.out else d.message.date)
        except Exception:
            pass
        return None, None

    async def wait_disconnected(self) -> TgError | None:
        try:
            await self._c.disconnected
        except BaseException as e:
            if isinstance(e, asyncio.CancelledError):
                raise
            return classify(e)
        err = getattr(self._c, "_updates_error", None)  # set by Telethon's update loop on auth failures
        return classify(err) if err else None

    def session_string(self) -> str:
        return self._c.session.save()

    def on_private_message(self, cb: MessageCallback) -> None:
        async def handler(event: events.NewMessage.Event) -> None:
            if not event.is_private:
                return
            peer = await event.get_chat()
            if _is_fan(peer):
                await cb(not event.out, event.message.date)

        self._c.add_event_handler(handler, events.NewMessage())


def telethon_factory(p: ConnectParams) -> TgClient:
    return TelethonClient(p)
