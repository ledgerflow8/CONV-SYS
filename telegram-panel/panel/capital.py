"""The one door to Capitalbot (CLAUDE.md: every call goes through capital.py).

It owns the `/generateResponse` and `/getModelsAndPresets` HTTP contract from `CapitalAI_Docs.md`,
the request/response shapes, and the retry policy (PLAN.md §4.3 step 7):

- A connection that never opened and a `429` are retried **once** — Capitalbot never processed them.
- A timeout or `5xx` is **never** retried — Capitalbot may already have generated a reply.
- `400`/`401`/`403` raise with `pause=True` so the caller switches the account's AI off.

The flag handling (which flag means what) lives in `ai.py`; this module only classifies and parses.
"""

import asyncio
import json
import logging
import time
from dataclasses import dataclass, field
from typing import Any

import httpx

log = logging.getLogger("panel.capital")

BASE_URL = "https://api.capitalbot.ai"
# The `platform` value Capitalbot accepts for our accounts. It is CASE-SENSITIVE: the engine accepts
# "Telegram" but rejects "telegram" with a 500 (confirmed by scripts/diag_capital.py --sweep-platform,
# and CapitalAI_Docs.md:315 names "Telegram"). Do not lowercase or rename this.
PLATFORM = "Telegram"
GENERATE_TIMEOUT = 90.0
CATALOG_TIMEOUT = 30.0
CATALOG_TTL = 600.0  # 10 minutes (PLAN.md §5)
RETRY_DELAY = 10.0  # the once-only retry for a 429 / dropped connection when no retryAfter is given
RETRY_AFTER_CAP = 30.0  # never wait longer than this for a 429's retryAfter

# The only persona fields Capitalbot accepts as request overrides (PLAN.md §3).
ALLOWED_OVERRIDE_KEYS = frozenset(
    {
        "modelName", "modelAge", "city", "timezone", "appearance", "hobbies", "ctaInfo",
        "dayTimeActivity", "nightTimeActivity", "language", "detectLanguage", "photoRate",
        "chattingStyle", "interestLevel", "phaseGoal", "conversationSource", "audio", "video",
        "image", "matchLocation", "affiliate",
    }
)

# Our message kinds → the chatHistory media markers Capitalbot understands (docs "Media Types").
KIND_MARKERS = {
    "image": "*IMAGE*",
    "video": "*VIDEO*",
    "audio": "*AUDIO*",
    "gif": "*GIF*",
    "sticker": "*STICKER*",
    "location": "*LOCATION*",
}
# Which fan media kinds can be uploaded as a file for analysis (docs "Sending User Media").
UPLOADABLE_KINDS = frozenset({"image", "video", "audio"})

# The empty-content stop flags, in the order ai.py resolves them. Every one must be handled.
STOP_FLAGS = (
    "underage", "timewaste", "ppvExhausted", "tierFiltered", "genderFiltered", "ignored",
    "messagedAlready", "internalAccount", "aiCreditOver", "converted",
)


@dataclass(frozen=True)
class ContentItem:
    type: str  # text · image · video · audio
    content: str  # the text, or a media URL
    media_pool: str | None = None


@dataclass
class CapitalResponse:
    content: list[ContentItem]
    flags: dict[str, bool]
    conversation_id: int | None
    cooldown_until: int | None  # chatCooldownUntil, unix seconds
    raw: dict[str, Any] = field(default_factory=dict)

    def flag(self, name: str) -> bool:
        return bool(self.flags.get(name))

    @property
    def stop_flag(self) -> str | None:
        """The first set stop flag, or None. `chatCooldown` is handled separately (not a stop)."""
        for name in STOP_FLAGS:
            if self.flags.get(name):
                return name
        return None

    @property
    def has_content(self) -> bool:
        return bool(self.content)


class CapitalError(Exception):
    """A Capitalbot call that did not return a usable 200.

    `kind` drives ai.py's handling:
      - connection / rate_limited → the request never reached Capitalbot (already retried once here).
      - timeout / server          → it may have generated a reply; never retried, wait for the next fan message.
      - client                    → a 400/401/403; `pause` is set so the account's AI is switched off.
      - bad_response              → a 200 whose body wasn't the documented shape.
    """

    def __init__(self, kind: str, detail: str, *, status_code: int | None = None, pause: bool = False, retry_after: float | None = None):
        super().__init__(detail)
        self.kind = kind
        self.detail = detail
        self.status_code = status_code
        self.pause = pause
        self.retry_after = retry_after  # seconds Capitalbot asked us to wait (429 only)


class CapitalClient:
    def __init__(
        self,
        license_key: str | None,
        http: httpx.AsyncClient,
        base_url: str = BASE_URL,
        retry_delay: float = RETRY_DELAY,
    ):
        self.license_key = license_key
        self._http = http
        self._base = base_url.rstrip("/")
        self._retry_delay = retry_delay
        self._catalog_cache: tuple[float, dict] | None = None

    @property
    def configured(self) -> bool:
        return bool(self.license_key)

    # ── catalog (models + presets) ───────────────────────────────────────────
    async def catalog(self, include_archived: bool = False, force: bool = False) -> dict:
        now = time.monotonic()
        if not force and not include_archived and self._catalog_cache and now - self._catalog_cache[0] < CATALOG_TTL:
            return self._catalog_cache[1]
        body = {"licensekey": self.license_key, "includeArchived": include_archived}
        resp = await self._http.post(f"{self._base}/getModelsAndPresets", json=body, timeout=CATALOG_TIMEOUT)
        if resp.status_code != 200:
            raise CapitalError("client" if resp.status_code < 500 else "server", f"catalog returned {resp.status_code}", status_code=resp.status_code)
        data = resp.json()
        payload = data.get("data", data) if isinstance(data, dict) else {}
        out = {
            "models": [{"id": m.get("modelId"), "name": m.get("name")} for m in payload.get("models", []) if isinstance(m, dict)],
            "presets": [
                {"id": p.get("id"), "name": p.get("name"), "archived": bool(p.get("archived"))}
                for p in payload.get("presets", [])
                if isinstance(p, dict)
            ],
        }
        if not include_archived:
            self._catalog_cache = (now, out)
        return out

    # ── generate a chat response ──────────────────────────────────────────────
    async def generate_response(
        self,
        *,
        model_id: int,
        preset_id: int,
        account_id: str,
        user_infos: dict,
        chat_history: list[dict],
        overrides: dict | None = None,
        file_path: str | None = None,
    ) -> CapitalResponse:
        fields: dict[str, Any] = {
            "licensekey": self.license_key,
            "modelId": model_id,
            "presetId": preset_id,
            "accountId": account_id,
            "platform": PLATFORM,
            "userInfos": user_infos,
            "chatHistory": chat_history,
        }
        for k, v in (overrides or {}).items():
            if k in ALLOWED_OVERRIDE_KEYS and v is not None:
                fields[k] = v

        # Exactly what we send, license key redacted, so a bad modelId/presetId/history is visible in the logs.
        log.info("capital generateResponse → %s", _redact(fields, file_path))

        last_exc: CapitalError | None = None
        for attempt in (1, 2):
            try:
                resp = await self._post_generate(fields, file_path)
            except CapitalError as e:
                last_exc = e
                if e.kind in ("connection", "rate_limited") and attempt == 1:
                    if e.kind == "rate_limited":
                        # Honour the server's retryAfter (e.g. its "Duplicate request" guard), capped.
                        delay = min(RETRY_AFTER_CAP, e.retry_after + 1 if e.retry_after else self._retry_delay)
                        if delay:
                            await asyncio.sleep(delay)
                    log.info("capital %s on attempt %s; retrying once", e.kind, attempt)
                    continue
                raise
            return self._parse(resp)
        assert last_exc is not None  # the loop only falls through after a raise
        raise last_exc

    async def _post_generate(self, fields: dict, file_path: str | None) -> httpx.Response:
        url = f"{self._base}/generateResponse"
        try:
            if file_path:
                # Multipart: chatHistory and userInfos go as JSON strings (docs "Sending User Media").
                data = {
                    k: (v if isinstance(v, str) else json.dumps(v) if isinstance(v, (dict, list)) else str(v))
                    for k, v in fields.items()
                }
                with open(file_path, "rb") as fh:
                    files = {"file": (file_path.rsplit("/", 1)[-1], fh.read())}
                resp = await self._http.post(url, data=data, files=files, timeout=GENERATE_TIMEOUT)
            else:
                resp = await self._http.post(url, json=fields, timeout=GENERATE_TIMEOUT)
        except (httpx.ConnectError, httpx.ConnectTimeout) as e:
            raise CapitalError("connection", f"couldn't open a connection to Capitalbot ({type(e).__name__})") from e
        except httpx.TimeoutException as e:
            raise CapitalError("timeout", f"Capitalbot timed out after {GENERATE_TIMEOUT:.0f}s ({type(e).__name__})") from e
        except httpx.RequestError as e:
            # The request may not have left; treat like a dropped connection (retried once).
            raise CapitalError("connection", f"request to Capitalbot failed ({type(e).__name__})") from e

        code = resp.status_code
        if code == 200:
            return resp
        if code == 429:
            raise CapitalError(
                "rate_limited",
                f"Capitalbot rate-limited the request (429): {_short(resp)}",
                status_code=429,
                retry_after=_retry_after(resp),
            )
        if code in (400, 401, 403):
            raise CapitalError("client", f"Capitalbot rejected the request ({code}): {_short(resp)}", status_code=code, pause=True)
        if 500 <= code < 600:
            raise CapitalError("server", f"Capitalbot returned {code}", status_code=code)
        raise CapitalError("server", f"Capitalbot returned an unexpected {code}", status_code=code)

    def _parse(self, resp: httpx.Response) -> CapitalResponse:
        try:
            data = resp.json()
        except ValueError as e:
            raise CapitalError("bad_response", "Capitalbot returned a 200 that wasn't JSON") from e
        if not isinstance(data, dict):
            raise CapitalError("bad_response", "Capitalbot returned a 200 that wasn't an object")

        # A 200 can still carry a server-side failure (e.g. {"error": "Internal server error"}): surface
        # it as an error, not as the "empty content, no flag" Capitalbot-bug path. Not retried, not paused.
        err = data.get("error")
        if isinstance(err, str) and err.strip():
            raise CapitalError("server", f"Capitalbot returned an error in a 200 body: {err.strip()[:200]}", status_code=200)

        content: list[ContentItem] = []
        for item in data.get("content") or []:
            if not isinstance(item, dict):
                continue
            t, c = item.get("type"), item.get("content")
            if t in ("text", "image", "video", "audio") and isinstance(c, str) and c:
                content.append(ContentItem(type=t, content=c, media_pool=item.get("mediaPool")))

        flags = {
            name: bool(data.get(name))
            for name in (
                "converted", "underage", "timewaste", "tierFiltered", "genderFiltered",
                "aiCreditOver", "messagedAlready", "internalAccount", "ignored",
                "ppvExhausted", "chatCooldown",
            )
        }
        stats = data.get("statistics") if isinstance(data.get("statistics"), dict) else {}
        conv_id = data.get("conversationId")
        if conv_id is None and isinstance(stats, dict):
            conv_id = stats.get("conversationId")
        cooldown = data.get("chatCooldownUntil")
        return CapitalResponse(
            content=content,
            flags=flags,
            conversation_id=int(conv_id) if isinstance(conv_id, (int, float, str)) and str(conv_id).lstrip("-").isdigit() else None,
            cooldown_until=int(cooldown) if isinstance(cooldown, (int, float)) else None,
            raw=data,
        )


def _redact(fields: dict, file_path: str | None) -> str:
    """The outgoing request body as JSON, with the license key hidden and any attached file named."""
    safe = {k: ("***" if k == "licensekey" else v) for k, v in fields.items()}
    if file_path:
        safe["_file"] = file_path.rsplit("/", 1)[-1]
    return json.dumps(safe, ensure_ascii=False, default=str)


def _retry_after(resp: httpx.Response) -> float | None:
    """Seconds Capitalbot asked us to wait: the body's `retryAfter` or the `Retry-After` header."""
    try:
        body = resp.json()
        if isinstance(body, dict) and isinstance(body.get("retryAfter"), (int, float)):
            return float(body["retryAfter"])
    except ValueError:
        pass
    header = resp.headers.get("retry-after")
    if header and header.strip().isdigit():
        return float(header.strip())
    return None


def _short(resp: httpx.Response) -> str:
    try:
        body = resp.json()
        msg = body.get("error") or body.get("message") if isinstance(body, dict) else None
        return str(msg)[:200] if msg else resp.text[:200]
    except ValueError:
        return resp.text[:200]
