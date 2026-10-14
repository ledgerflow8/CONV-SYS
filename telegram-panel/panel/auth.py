"""Panel login: one password (argon2 hash in the settings table), a signed session cookie,
and a failure rate limit. Changing the password bumps `session_epoch`, which logs out every
existing cookie."""

import time
from collections import deque

from argon2 import PasswordHasher
from argon2.exceptions import InvalidHashError, VerificationError
from fastapi import HTTPException, Request
from itsdangerous import BadSignature, SignatureExpired, TimestampSigner

from panel.db import get_setting, set_setting

COOKIE = "tgpanel_session"
COOKIE_MAX_AGE = 30 * 24 * 3600
PASSWORD_MIN_LEN = 10

_hasher = PasswordHasher()


def hash_password(password: str) -> str:
    return _hasher.hash(password)


def verify_password(stored_hash: str, password: str) -> bool:
    try:
        return _hasher.verify(stored_hash, password)
    except (VerificationError, InvalidHashError):
        return False


async def store_password(session, password: str) -> None:
    """Sets the password and logs out every existing session."""
    if len(password) < PASSWORD_MIN_LEN:
        raise ValueError(f"password must be at least {PASSWORD_MIN_LEN} characters")
    epoch = int(await get_setting(session, "session_epoch", 0)) + 1
    await set_setting(session, "password_hash", hash_password(password))
    await set_setting(session, "session_epoch", epoch)


class Signer:
    def __init__(self, secret: str):
        self._s = TimestampSigner(secret, salt="tgpanel-session")

    def make(self, epoch: int) -> str:
        return self._s.sign(str(epoch)).decode()

    def epoch_of(self, cookie: str) -> int | None:
        try:
            return int(self._s.unsign(cookie, max_age=COOKIE_MAX_AGE))
        except (BadSignature, SignatureExpired, ValueError):
            return None


class LoginLimiter:
    """Failed logins: at most `per_ip` per IP and `total` overall in each window."""

    def __init__(self, per_ip: int = 5, total: int = 30, window_sec: int = 15 * 60):
        self.per_ip, self.total, self.window = per_ip, total, window_sec
        self._by_ip: dict[str, deque[float]] = {}
        self._all: deque[float] = deque()

    def _prune(self, q: deque[float], now: float) -> None:
        while q and q[0] <= now - self.window:
            q.popleft()

    def retry_after(self, ip: str, now: float | None = None) -> int:
        """Seconds until this IP may try again; 0 if it may try now."""
        now = time.monotonic() if now is None else now
        q = self._by_ip.get(ip, deque())
        self._prune(q, now)
        self._prune(self._all, now)
        waits = []
        if len(q) >= self.per_ip:
            waits.append(q[0] + self.window - now)
        if len(self._all) >= self.total:
            waits.append(self._all[0] + self.window - now)
        return max(1, int(max(waits))) if waits else 0

    def fail(self, ip: str, now: float | None = None) -> None:
        now = time.monotonic() if now is None else now
        self._by_ip.setdefault(ip, deque()).append(now)
        self._all.append(now)

    def reset(self, ip: str) -> None:
        self._by_ip.pop(ip, None)


async def require_login(request: Request) -> None:
    """Route dependency: 401 unless the request carries a valid, current session cookie."""
    cookie = request.cookies.get(COOKIE)
    epoch = request.app.state.signer.epoch_of(cookie) if cookie else None
    if epoch is None:
        raise HTTPException(401, "Not logged in")
    async with request.app.state.sessionmaker() as session:
        current = int(await get_setting(session, "session_epoch", 0))
    if epoch != current:
        raise HTTPException(401, "Session ended")
