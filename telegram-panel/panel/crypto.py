"""Encryption at rest for session strings, 2FA passwords and proxy credentials.

PANEL_ENC_KEY holds one or more Fernet keys, comma-separated. The first encrypts; all decrypt,
so a key can be rotated by prepending the new one and re-saving.
"""

from cryptography.fernet import Fernet, InvalidToken, MultiFernet

__all__ = ["Crypto", "InvalidToken", "generate_key"]


def generate_key() -> str:
    return Fernet.generate_key().decode()


class Crypto:
    def __init__(self, keys: str):
        parts = [k.strip() for k in keys.split(",") if k.strip()]
        if not parts:
            raise ValueError("PANEL_ENC_KEY is empty")
        try:
            self._f = MultiFernet([Fernet(k.encode()) for k in parts])
        except ValueError as e:
            raise ValueError("PANEL_ENC_KEY must be Fernet keys (python -m panel gen-key)") from e

    def encrypt(self, plaintext: str) -> bytes:
        return self._f.encrypt(plaintext.encode())

    def decrypt(self, token: bytes) -> str:
        return self._f.decrypt(token).decode()

    def rotate(self, token: bytes) -> bytes:
        return self._f.rotate(token)
