"""Password-protected, encrypted backup of all accounts (PLAN.md §10).

The archive is a self-contained disaster-recovery file: it carries the *decrypted* secrets (session
strings, 2FA and proxy), re-encrypted under a key derived from a password the owner sets at export
time — so it restores onto a fresh panel with a different PANEL_ENC_KEY. Never written to disk here;
the route streams it to the owner's download.

Layout:  MAGIC + version(1 byte) + salt(16) + Fernet token
The Fernet key is scrypt(password, salt); the token's plaintext is JSON {"version", "accounts":[…]}.
"""

import base64
import json
import os

from cryptography.fernet import Fernet, InvalidToken
from cryptography.hazmat.primitives.kdf.scrypt import Scrypt

MAGIC = b"TGPANEL-BACKUP\n"
VERSION = 1
SALT_LEN = 16
# scrypt work factors: strong for an interactive one-off, fine for a ~100-account archive.
_N, _R, _P = 2**15, 8, 1


class BackupError(ValueError):
    pass


def _key(password: str, salt: bytes) -> bytes:
    kdf = Scrypt(salt=salt, length=32, n=_N, r=_R, p=_P)
    return base64.urlsafe_b64encode(kdf.derive(password.encode()))


def export_archive(accounts: list[dict], password: str) -> bytes:
    if not password:
        raise BackupError("A backup password is required.")
    salt = os.urandom(SALT_LEN)
    token = Fernet(_key(password, salt)).encrypt(json.dumps({"version": VERSION, "accounts": accounts}).encode())
    return MAGIC + bytes([VERSION]) + salt + token


def import_archive(blob: bytes, password: str) -> list[dict]:
    if not blob.startswith(MAGIC):
        raise BackupError("This isn't a panel backup file.")
    body = blob[len(MAGIC) :]
    if not body or body[0] != VERSION:
        raise BackupError("Unsupported backup version.")
    salt, token = body[1 : 1 + SALT_LEN], body[1 + SALT_LEN :]
    if len(salt) != SALT_LEN or not token:
        raise BackupError("The backup file is truncated.")
    try:
        plaintext = Fernet(_key(password, salt)).decrypt(token)
    except InvalidToken:
        raise BackupError("Wrong backup password, or the file is corrupt.") from None
    try:
        data = json.loads(plaintext.decode())
        accounts = data["accounts"]
    except (ValueError, KeyError, TypeError):
        raise BackupError("The backup file is malformed.") from None
    if not isinstance(accounts, list):
        raise BackupError("The backup file is malformed.")
    return accounts
