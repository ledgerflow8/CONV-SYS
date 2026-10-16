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
class ProfileInfo:
    """The editable profile, read live from Telegram to prefill the edit form."""

    first_name: str | None
    last_name: str | None
    about: str | None  # bio
    username: str | None  # lowercase, no @


@dataclass(frozen=True)
class PeerInfo:
    peer_id: str  # the fan's Telegram id, as a string
    username: str | None  # lowercase, no @
    name: str | None
    phone: str | None  # E.164 with +, when Telegram shows it


@dataclass(frozen=True)
class IncomingMessage:
    """A private message seen on an account, in either direction (PLAN.md §4.3)."""

    peer: PeerInfo
    tg_msg_id: int
    out: bool  # True when the account sent it (manual or AI); False when the fan did
    kind: str  # text · image · video · audio · gif · sticker · location · other
    text: str | None
    at: datetime  # timezone-aware UTC


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
    """A Telegram failure mapped to an account status.

    `raw` is the underlying Telegram exception's class name (or None when the panel itself
    raised the error, e.g. the in-process "already connected" guard), so logs can show what
    Telegram actually returned, not just the human message.
    """

    def __init__(self, status: str, detail: str, raw: str | None = None, retry_after: int | None = None):
        super().__init__(detail)
        self.status = status  # revoked · banned · limited · error · username_taken · username_invalid
        self.detail = detail
        self.raw = raw
        self.retry_after = retry_after  # seconds Telegram asked us to wait (FloodWait only)

    @property
    def dead(self) -> bool:
        return self.status in ("revoked", "banned")


def classify(e: BaseException) -> TgError:
    if isinstance(e, TgError):
        return e
    raw = type(e).__name__
    if isinstance(e, errors.AuthKeyDuplicatedError):
        return TgError("revoked", "Session was used from two places at once and Telegram ended it", raw)
    if isinstance(e, (errors.UserDeactivatedBanError, errors.PhoneNumberBannedError)):
        return TgError("banned", "Account is banned by Telegram", raw)
    if isinstance(e, errors.UserDeactivatedError):
        return TgError("banned", "Account was deleted or deactivated", raw)
    if isinstance(e, (errors.AuthKeyUnregisteredError, errors.SessionRevokedError, errors.SessionExpiredError)):
        return TgError("revoked", "Session was logged out or revoked", raw)
    if isinstance(e, (errors.UnauthorizedError, errors.AuthKeyError)):
        return TgError("revoked", f"Session isn't authorised ({raw})", raw)
    if isinstance(e, errors.FloodWaitError):
        return TgError("limited", f"Telegram asked to wait {e.seconds}s", raw, retry_after=e.seconds)
    if isinstance(e, (asyncio.TimeoutError, ConnectionError, OSError)):
        return TgError("error", "Couldn't reach Telegram", raw)
    return TgError("error", f"{type(e).__name__}: {e}"[:300], raw)


MessageCallback = Callable[[IncomingMessage], Awaitable[None]]


class TgClient(Protocol):
    async def start(self) -> AccountInfo: ...
    async def disconnect(self) -> None: ...
    async def log_out(self) -> None: ...
    async def download_avatar(self, path: Path) -> bool: ...
    async def last_activity(self) -> tuple[datetime | None, datetime | None]: ...
    async def dialog_firsts(self, peer_id: int) -> tuple[datetime | None, datetime | None]: ...
    async def wait_disconnected(self) -> TgError | None: ...
    def session_string(self) -> str: ...
    def on_private_message(self, cb: MessageCallback) -> None: ...
    # Sending (step 3, used by the AI worker). Each returns the sent message's Telegram id.
    async def send_text(self, peer_id: int, text: str) -> int: ...
    async def send_file(self, peer_id: int, path: str, *, voice: bool = False) -> int: ...
    async def mark_read(self, peer_id: int) -> None: ...
    async def typing(self, peer_id: int, seconds: float) -> None: ...
    async def download_message_media(self, peer_id: int, tg_msg_id: int, dest_dir: Path) -> Path | None: ...
    # Profile editing (uses this same connection; never opens a second one).
    async def get_profile(self) -> ProfileInfo: ...
    async def check_username(self, username: str) -> bool: ...
    async def update_profile(self, first_name: str, last_name: str, about: str) -> None: ...
    async def set_username(self, username: str) -> None: ...
    async def set_profile_photo(self, path: str) -> None: ...
    async def delete_profile_photo(self) -> None: ...


ClientFactory = Callable[[ConnectParams], TgClient]


def _is_fan(user: object) -> bool:
    return isinstance(user, types.User) and not user.bot and not user.is_self and user.id != TELEGRAM_SERVICE_ID


def _peer_info(user: types.User) -> PeerInfo:
    username = user.username
    if not username and getattr(user, "usernames", None):
        username = next((u.username for u in user.usernames if u.active), None)
    name = " ".join(p for p in (user.first_name, user.last_name) if p) or None
    return PeerInfo(
        peer_id=str(user.id),
        username=username.lower() if username else None,
        name=name,
        phone=f"+{user.phone}" if user.phone else None,
    )


def _kind(message: types.Message) -> str:
    """Map a Telethon message to one of the panel's media kinds."""
    if message.photo:
        return "image"
    if message.video or message.video_note:
        return "video"
    if message.voice or message.audio:
        return "audio"
    if message.gif:
        return "gif"
    if message.sticker:
        return "sticker"
    if message.geo:
        return "location"
    if message.media:
        return "other"
    return "text"


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

    async def dialog_firsts(self, peer_id: int) -> tuple[datetime | None, datetime | None]:
        """The fan's first message in this chat, and the account's first message at or after it.
        Read straight from Telegram so first_in_at is the real start, not just what we've seen."""
        first_in: datetime | None = None
        first_reply: datetime | None = None
        try:
            async for m in self._c.iter_messages(peer_id, reverse=True, limit=200):
                if m.date is None:
                    continue
                if not m.out and first_in is None:
                    first_in = m.date
                elif m.out and first_in is not None and first_reply is None and m.date >= first_in:
                    first_reply = m.date
                if first_in is not None and first_reply is not None:
                    break
        except Exception:
            pass
        return first_in, first_reply

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

    # ── sending (step 3) ──────────────────────────────────────────────────────
    async def send_text(self, peer_id: int, text: str) -> int:
        m = await self._c.send_message(peer_id, text)
        return m.id

    async def send_file(self, peer_id: int, path: str, *, voice: bool = False) -> int:
        m = await self._c.send_file(peer_id, path, voice_note=voice)
        return m.id

    async def mark_read(self, peer_id: int) -> None:
        await self._c.send_read_acknowledge(peer_id)

    async def typing(self, peer_id: int, seconds: float) -> None:
        if seconds <= 0:
            return
        async with self._c.action(peer_id, "typing"):
            await asyncio.sleep(seconds)

    async def download_message_media(self, peer_id: int, tg_msg_id: int, dest_dir: Path) -> Path | None:
        msg = await self._c.get_messages(peer_id, ids=tg_msg_id)
        if msg is None or not msg.media:
            return None
        dest_dir.mkdir(parents=True, exist_ok=True)
        got = await msg.download_media(file=str(dest_dir) + "/")
        return Path(got) if got else None

    # ── profile editing (uses this same live connection) ──────────────────────
    async def get_profile(self) -> ProfileInfo:
        try:
            me = await self._c.get_me()
            full = await self._c(functions.users.GetFullUserRequest(types.InputUserSelf()))
            about = full.full_user.about
        except Exception as e:
            raise classify(e) from e
        username = me.username
        if not username and getattr(me, "usernames", None):
            username = next((u.username for u in me.usernames if u.active), None)
        return ProfileInfo(
            first_name=me.first_name,
            last_name=me.last_name,
            about=about,
            username=username.lower() if username else None,
        )

    async def check_username(self, username: str) -> bool:
        """True if the username is free for this account. Invalid usernames raise username_invalid."""
        try:
            return bool(await self._c(functions.account.CheckUsernameRequest(username)))
        except errors.UsernameInvalidError as e:
            raise TgError("username_invalid", "That username isn't valid.", type(e).__name__) from e
        except Exception as e:
            raise classify(e) from e

    async def update_profile(self, first_name: str, last_name: str, about: str) -> None:
        try:
            await self._c(functions.account.UpdateProfileRequest(first_name=first_name, last_name=last_name, about=about))
        except Exception as e:
            raise classify(e) from e

    async def set_username(self, username: str) -> None:
        try:
            await self._c(functions.account.UpdateUsernameRequest(username))
        except errors.UsernameOccupiedError as e:
            raise TgError("username_taken", "That username is already taken.", type(e).__name__) from e
        except (errors.UsernameInvalidError, errors.UsernameNotModifiedError) as e:
            raise TgError("username_invalid", "That username isn't valid.", type(e).__name__) from e
        except Exception as e:
            raise classify(e) from e

    async def set_profile_photo(self, path: str) -> None:
        try:
            uploaded = await self._c.upload_file(path)
            await self._c(functions.photos.UploadProfilePhotoRequest(file=uploaded))
        except Exception as e:
            raise classify(e) from e

    async def delete_profile_photo(self) -> None:
        try:
            photos = await self._c.get_profile_photos("me", limit=1)
            if photos:
                p = photos[0]
                await self._c(
                    functions.photos.DeletePhotosRequest(
                        [types.InputPhoto(id=p.id, access_hash=p.access_hash, file_reference=p.file_reference)]
                    )
                )
        except Exception as e:
            raise classify(e) from e

    def on_private_message(self, cb: MessageCallback) -> None:
        async def handler(event: events.NewMessage.Event) -> None:
            if not event.is_private:
                return
            peer = await event.get_chat()  # the other party, in either direction
            if not _is_fan(peer):
                return
            m = event.message
            await cb(
                IncomingMessage(
                    peer=_peer_info(peer),
                    tg_msg_id=m.id,
                    out=bool(event.out),
                    kind=_kind(m),
                    text=m.message or None,
                    at=m.date,
                )
            )

        # Both directions: a reply typed on the client's own phone must be seen too (PLAN.md §3).
        self._c.add_event_handler(handler, events.NewMessage(incoming=True, outgoing=True))


def telethon_factory(p: ConnectParams) -> TgClient:
    return TelethonClient(p)
