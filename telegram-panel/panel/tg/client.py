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

# Telegram sometimes sends updates from a newer API layer than our Telethon understands. A single
# such update is skipped by Telethon's receive loop, but one that lands in a getDifference response
# makes Telethon tear the connection down (client/updates.py). We classify it as a transient error
# with a human message (never the raw "Could not find a matching Constructor ID…") so the service
# reconnects instead of parking the account Off. A fresh StringSession connection re-baselines on
# getState and skips the unreadable backlog, so the reconnect sticks.
UNREADABLE_UPDATE_DETAIL = "Telegram sent data from a newer app version — reconnecting."

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
class ChatScan:
    """One chat read back from Telegram (recovery after messages failed to save, PLAN.md §4.3)."""

    peer: PeerInfo
    first_in: datetime | None  # the fan's first message ever (None: the account messaged first)
    first_reply: datetime | None  # the account's first message at or after it
    recent: list[IncomingMessage]  # messages since the scan's `since`, oldest first


# Capitalbot accepts files up to 50 MB; anything bigger is never downloaded (it would only fill the disk).
MAX_MEDIA_BYTES = 50 * 1024 * 1024


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

    @property
    def leave_alone(self) -> bool:
        """Terminal states the panel must not reconnect: a dead session (banned/revoked) or a
        frozen account. Everything else (network, timeout, unreadable update) is transient."""
        return self.status in ("revoked", "banned", "frozen")


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
    # Frozen: Telegram froze the account or write-restricted it (distinct from a hard ban).
    _frozen = tuple(t for t in (getattr(errors, n, None) for n in ("UserRestrictedError", "PeerFloodError", "FrozenError", "FrozenMethodInvalidError")) if isinstance(t, type))
    if "FROZEN" in f"{raw} {e}".upper() or (_frozen and isinstance(e, _frozen)):
        return TgError("frozen", "Account is frozen or write-restricted by Telegram", raw)
    # An update/difference Telethon can't deserialize (newer Telegram layer). Transient: reconnect.
    if isinstance(e, errors.TypeNotFoundError):
        return TgError("error", UNREADABLE_UPDATE_DETAIL, raw)
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
    # Recovery: read recent private chats back from Telegram (read-only; raises TgError).
    async def recent_peers(self, since: datetime) -> list[PeerInfo]: ...
    async def scan_chat(self, peer_id: int, since: datetime) -> ChatScan: ...
    # Profile editing (uses this same connection; never opens a second one).
    async def get_profile(self) -> ProfileInfo: ...
    async def check_username(self, username: str) -> bool: ...
    async def update_profile(self, first_name: str, last_name: str, about: str) -> None: ...
    async def set_username(self, username: str) -> None: ...
    async def set_profile_photo(self, path: str) -> None: ...
    async def delete_profile_photo(self) -> None: ...
    # Account security.
    async def terminate_other_sessions(self) -> None: ...
    async def set_2fa(self, current_password: str | None, new_password: str) -> None: ...
    # Presence: tell Telegram the account is online (so it shows "online", not "last seen …").
    async def set_online(self) -> None: ...


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
        size = getattr(msg.file, "size", None) if msg.file else None
        if size is not None and size > MAX_MEDIA_BYTES:
            return None  # over Capitalbot's limit: never written to disk
        dest_dir.mkdir(parents=True, exist_ok=True)
        # A failed download can leave a partial file behind; the housekeeping media sweep removes it.
        got = await msg.download_media(file=str(dest_dir) + "/")
        return Path(got) if got else None

    # ── recovery (read-only) ──────────────────────────────────────────────────
    async def recent_peers(self, since: datetime) -> list[PeerInfo]:
        """Fans in private chats with any message at or after `since`, newest first."""
        out: list[PeerInfo] = []
        try:
            async for d in self._c.iter_dialogs():
                if d.date is None:
                    continue
                if d.date < since:
                    if d.pinned:
                        continue  # pinned chats sit on top regardless of date
                    break  # dialogs come newest first
                if d.is_user and _is_fan(d.entity):
                    out.append(_peer_info(d.entity))
        except Exception as e:
            raise classify(e) from e
        return out

    async def scan_chat(self, peer_id: int, since: datetime) -> ChatScan:
        try:
            entity = await self._c.get_entity(peer_id)
            first_in: datetime | None = None
            first_reply: datetime | None = None
            async for m in self._c.iter_messages(entity, reverse=True, limit=200):
                if m.date is None:
                    continue
                if not m.out and first_in is None:
                    first_in = m.date
                elif m.out and first_in is not None and first_reply is None and m.date >= first_in:
                    first_reply = m.date
                if first_in is not None and first_reply is not None:
                    break
            peer = _peer_info(entity)
            recent: list[IncomingMessage] = []
            async for m in self._c.iter_messages(entity, limit=100):
                if m.date is None:
                    continue
                if m.date < since:
                    break
                recent.append(IncomingMessage(peer=peer, tg_msg_id=m.id, out=bool(m.out), kind=_kind(m), text=m.message or None, at=m.date))
        except Exception as e:
            raise classify(e) from e
        recent.reverse()
        return ChatScan(peer=peer, first_in=first_in, first_reply=first_reply, recent=recent)

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

    async def _delete_all_profile_photos(self) -> None:
        """Remove the account's whole profile-photo history (Telegram keeps every past photo)."""
        photos = await self._c.get_profile_photos("me", limit=200)
        inputs = [types.InputPhoto(id=p.id, access_hash=p.access_hash, file_reference=p.file_reference) for p in photos]
        if inputs:
            await self._c(functions.photos.DeletePhotosRequest(inputs))

    async def _profile_photo_count(self) -> int:
        return len(await self._c.get_profile_photos("me", limit=200))

    async def set_profile_photo(self, path: str) -> None:
        # A TRUE replace: wipe the photo history first, then upload the new one. Otherwise Telegram
        # keeps the old photos and they reappear in the carousel ("adding a photo brings the old ones back").
        try:
            await self._delete_all_profile_photos()
            uploaded = await self._c.upload_file(path)
            await self._c(functions.photos.UploadProfilePhotoRequest(file=uploaded))
            remaining = await self._profile_photo_count()
        except Exception as e:
            raise classify(e) from e
        if remaining != 1:
            raise TgError("photo_failed", f"Couldn't replace the photo cleanly — Telegram still shows {remaining}. Try again.")

    async def delete_profile_photo(self) -> None:
        # Delete ALL profile photos, not just the latest — otherwise Telegram promotes the previous one
        # and the avatar appears unchanged ("Remove photo did nothing").
        try:
            await self._delete_all_profile_photos()
            remaining = await self._profile_photo_count()
        except Exception as e:
            raise classify(e) from e
        if remaining != 0:
            raise TgError("photo_failed", f"Couldn't remove the photo — Telegram still shows {remaining}. Try again.")

    # ── account security ─────────────────────────────────────────────────────
    async def _reset_available_at(self) -> datetime | None:
        """When ResetAuthorizations will be allowed: the current session's creation time + 24h."""
        from datetime import timedelta

        try:
            auths = await self._c(functions.account.GetAuthorizationsRequest())
            for a in auths.authorizations:
                if getattr(a, "current", False) or a.hash == 0:
                    return a.date_created + timedelta(hours=24)
        except Exception:
            return None
        return None

    async def terminate_other_sessions(self) -> None:
        """Log out every OTHER Telegram session for this account; ours is kept. Telegram forbids this
        in the first 24h after a session signs in (FRESH_RESET_AUTHORISATION_FORBIDDEN)."""
        try:
            await self._c(functions.auth.ResetAuthorizationsRequest())
        except errors.FreshResetAuthorisationForbiddenError as e:
            avail = await self._reset_available_at()
            when = f" Available after {avail:%Y-%m-%d %H:%M} UTC." if avail else ""
            raise TgError("reset_too_fresh", "Telegram blocks resetting other sessions for 24h after sign-in." + when, type(e).__name__) from e
        except Exception as e:
            raise classify(e) from e

    async def set_2fa(self, current_password: str | None, new_password: str) -> None:
        """Set or change the account's 2FA (cloud) password. Telegram needs the current password when
        one is already set; pass the supplier's existing password from the .json for that."""
        try:
            await self._c.edit_2fa(current_password=current_password or None, new_password=new_password)
        except errors.PasswordHashInvalidError as e:
            raise TgError("twofa_wrong", "The current 2FA password on file is wrong, so it can't be changed.", type(e).__name__) from e
        except ValueError as e:
            # Telethon raises ValueError when a current password is required but none was given.
            raise TgError("twofa_needed", "This account already has 2FA set, and we don't have its current password to change it.", type(e).__name__) from e
        except Exception as e:
            raise classify(e) from e

    async def set_online(self) -> None:
        """Mark the account online (Telegram shows 'online' for ~5 min, then 'last seen recently')."""
        try:
            await self._c(functions.account.UpdateStatusRequest(offline=False))
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
