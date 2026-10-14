"""Maps the .json that often comes with a .session file. Sellers spell the keys differently,
so several spellings are accepted for each field."""

import re
from dataclasses import dataclass
from typing import Any
from urllib.parse import urlsplit


@dataclass(frozen=True)
class AccountMeta:
    api_id: int | None = None
    api_hash: str | None = None
    device_model: str | None = None
    system_version: str | None = None
    app_version: str | None = None
    lang_code: str | None = None
    system_lang_code: str | None = None
    twofa: str | None = None
    proxy: dict[str, Any] | None = None  # stored, not used (PLAN.md §10.7)
    user_id: int | None = None
    phone: str | None = None


KEYS = {
    "api_id": ("app_id", "api_id", "appId", "apiId"),
    "api_hash": ("app_hash", "api_hash", "appHash", "apiHash"),
    "device_model": ("device", "device_model", "deviceModel", "device_name"),
    "system_version": ("sdk", "system_version", "systemVersion", "os_version"),
    "app_version": ("app_version", "appVersion"),
    "lang_code": ("lang_code", "lang_pack", "langCode", "lang"),
    "system_lang_code": ("system_lang_code", "system_lang_pack", "systemLangCode"),
    "twofa": ("twoFA", "2fa", "twofa", "two_fa", "password", "2FA"),
    "user_id": ("user_id", "id", "userId", "uid"),
    "phone": ("phone", "phone_number", "phoneNumber"),
}


def _first(d: dict[str, Any], names: tuple[str, ...]) -> Any:
    for n in names:
        v = d.get(n)
        if v not in (None, "", []):
            return v
    return None


def _str(v: Any, limit: int = 128) -> str | None:
    if v is None or isinstance(v, (dict, list, bool)):
        return None
    s = str(v).strip()
    return s[:limit] or None


def _int(v: Any) -> int | None:
    if isinstance(v, bool):
        return None
    try:
        return int(str(v).strip())
    except (TypeError, ValueError):
        return None


def _proxy(v: Any) -> dict[str, Any] | None:
    """Accepts [type, host, port, rdns?, user?, pass?], a dict, or a URL."""
    if isinstance(v, list) and len(v) >= 3:
        kinds = {1: "socks4", 2: "socks5", 3: "http"}
        kind = kinds.get(v[0], v[0]) if isinstance(v[0], int) else str(v[0]).lower()
        p = {"type": kind, "host": str(v[1]), "port": _int(v[2])}
        if len(v) >= 6:
            p.update(user=_str(v[4]), password=_str(v[5]))
        return p if p["port"] else None
    if isinstance(v, dict):
        host, port = _str(v.get("addr") or v.get("host") or v.get("hostname")), _int(v.get("port"))
        if not host or not port:
            return None
        return {
            "type": str(v.get("proxy_type") or v.get("type") or v.get("scheme") or "socks5").lower(),
            "host": host,
            "port": port,
            "user": _str(v.get("username") or v.get("user")),
            "password": _str(v.get("password") or v.get("pass")),
        }
    if isinstance(v, str) and "://" in v:
        u = urlsplit(v)
        if u.hostname and u.port:
            return {"type": u.scheme.lower(), "host": u.hostname, "port": u.port, "user": u.username, "password": u.password}
    return None


def parse_meta(d: Any) -> AccountMeta:
    if not isinstance(d, dict):
        raise ValueError("the .json isn't an object")
    api_hash = _str(_first(d, KEYS["api_hash"]), 64)
    if api_hash and not re.fullmatch(r"[0-9a-fA-F]{32}", api_hash):
        api_hash = None
    phone = _str(_first(d, KEYS["phone"]), 32)
    if phone:
        digits = re.sub(r"\D", "", phone)
        phone = f"+{digits}" if digits else None
    return AccountMeta(
        api_id=_int(_first(d, KEYS["api_id"])),
        api_hash=api_hash,
        device_model=_str(_first(d, KEYS["device_model"])),
        system_version=_str(_first(d, KEYS["system_version"])),
        app_version=_str(_first(d, KEYS["app_version"]), 64),
        lang_code=_str(_first(d, KEYS["lang_code"]), 16),
        system_lang_code=_str(_first(d, KEYS["system_lang_code"]), 16),
        twofa=_str(_first(d, KEYS["twofa"]), 256),
        proxy=_proxy(d.get("proxy")),
        user_id=_int(_first(d, KEYS["user_id"])),
        phone=phone,
    )
