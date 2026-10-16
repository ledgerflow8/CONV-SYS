#!/usr/bin/env python3
"""Isolate what makes Capitalbot 500 for one chat, one field at a time.

Run it in Render's Shell (from the service root, where `panel/` lives):

    python scripts/diag_capital.py                      # defaults to @i965a1qrm539r469 / peer 1175302541
    python scripts/diag_capital.py <account_username> <peer_id>

It sends a request IDENTICAL to Capitalbot's Playground (which works), then repeats it swapping ONE
field at a time to what our panel actually sends for this chat — accountId, platform, userInfos,
chatHistory, and the persona overrides — and finally all of them together. It prints every request
body (license key masked) and each response, then names the first single change that triggers the error.

Read-only: it opens the panel DB for SELECTs only and makes outbound HTTPS calls to Capitalbot. It does
NOT open a Telegram connection, take the panel lock, or write anything.
"""

import asyncio
import copy
import json
import sys
import time
from pathlib import Path

# Make `panel` importable no matter the current directory.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import httpx
from sqlalchemy import select

from panel.ai import HISTORY_MESSAGES, build_chat_history, merged_overrides
from panel.capital import ALLOWED_OVERRIDE_KEYS, BASE_URL
from panel.config import get_settings
from panel.db import make_engine, make_sessionmaker
from panel.models import Account, Chat, Message

_flags = [a for a in sys.argv[1:] if a.startswith("--")]
_pos = [a for a in sys.argv[1:] if not a.startswith("--")]
ACCOUNT_USERNAME = _pos[0] if len(_pos) > 0 else "i965a1qrm539r469"
PEER_ID = _pos[1] if len(_pos) > 1 else "1175302541"
SWEEP_PLATFORM = "--sweep-platform" in _flags
RUNS = next((int(f.split("=", 1)[1]) for f in _flags if f.startswith("--runs=")), 1)

MODEL_ID = 3073
PRESET_ID = 6823

# platform `/generateResponse` accepts is not reliably documented; "Telegram" 500s for us. Sweep these,
# ordered by how well each fits a Telegram chat (Telegram links are always clickable, same as "Web").
PLATFORM_CANDIDATES = ["telegram", "Telegram", "TELEGRAM", "Web", "web", "Snapchat", "Instagram", None]


INTER_REQUEST_SLEEP = 1.5  # gentle spacing so we don't trip the rate limiter ourselves
_nonce = 0


def mask(body: dict) -> str:
    safe = {k: ("***" if k == "licensekey" else v) for k, v in body.items()}
    return json.dumps(safe, ensure_ascii=False, indent=2)


def uniquify(body: dict) -> dict:
    """Make the latest user message unique so Capitalbot's duplicate-request guard (429) never fires
    just because we sent the same text twice. Markers (*IMAGE* etc.) are left intact; only their
    timestamp is bumped."""
    global _nonce
    _nonce += 1
    b = copy.deepcopy(body)
    hist = b.get("chatHistory") or []
    now = int(time.time())
    for i in range(len(hist) - 1, -1, -1):
        if hist[i].get("role") == "user":
            content = str(hist[i].get("content", ""))
            is_marker = content.startswith("*") and content.endswith("*")
            hist[i] = {
                **hist[i],
                "content": content if is_marker else f"{content} [diag {now}-{_nonce}]",
                "timestamp": now,
            }
            break
    return b


def classify(status: int, data) -> str:
    """OK · RATE_LIMIT (429 duplicate/throttle) · ERROR_BODY (200 + error) · HTTP_4xx / HTTP_5xx."""
    if status == 429:
        return "RATE_LIMIT"
    if status == 200:
        if isinstance(data, dict) and isinstance(data.get("error"), str) and data["error"].strip():
            return "ERROR_BODY"
        return "OK"
    return f"HTTP_{status}"


def is_real_reject(label: str) -> bool:
    """A genuine rejection of our request shape — NOT a 429 rate-limit."""
    return label == "ERROR_BODY" or (label.startswith("HTTP_") and label != "HTTP_429")


def retry_after_of(data, headers) -> float:
    if isinstance(data, dict) and isinstance(data.get("retryAfter"), (int, float)):
        return float(data["retryAfter"])
    h = headers.get("retry-after", "")
    return float(h) if h.strip().isdigit() else 3.0


async def panel_request_parts(license_key: str) -> dict:
    """Reconstruct exactly what panel.ai would send for this chat, read from the live DB."""
    settings = get_settings()
    engine = make_engine(settings.db_path)
    sm = make_sessionmaker(engine)
    try:
        async with sm() as s:
            acc = await s.scalar(select(Account).where(Account.username == ACCOUNT_USERNAME))
            if acc is None:
                raise SystemExit(f"No account with username {ACCOUNT_USERNAME!r} in {settings.db_path}")
            chat = await s.scalar(select(Chat).where(Chat.account_id == acc.id, Chat.peer_id == PEER_ID))
            if chat is None:
                raise SystemExit(f"No chat for peer {PEER_ID!r} on account {ACCOUNT_USERNAME!r}")
            rows = (
                await s.scalars(
                    select(Message)
                    .where(Message.account_id == acc.id, Message.peer_id == PEER_ID)
                    .order_by(Message.at.desc())
                    .limit(HISTORY_MESSAGES)
                )
            ).all()
            msgs = list(reversed(rows))
            history = build_chat_history(msgs)

            user_infos = {"useridentifier": PEER_ID}
            if chat.peer_name:
                user_infos["name"] = chat.peer_name
            if chat.peer_username:
                user_infos["username"] = chat.peer_username

            overrides = {}
            if acc.profile_id is not None:
                from panel.models import Profile

                profile = await s.get(Profile, acc.profile_id)
                if profile is not None:
                    overrides = {
                        k: v
                        for k, v in merged_overrides(profile, acc).items()
                        if k in ALLOWED_OVERRIDE_KEYS and v is not None
                    }
            return {
                "accountId": str(acc.tg_user_id),
                "platform": "Telegram",
                "userInfos": user_infos,
                "chatHistory": history,
                "overrides": overrides,
            }
    finally:
        await engine.dispose()


def playground_base(license_key: str) -> dict:
    return {
        "licensekey": license_key,
        "modelId": MODEL_ID,
        "presetId": PRESET_ID,
        "accountId": "playground",
        "platform": "Playground",
        "userInfos": {"useridentifier": "986425151267", "name": "John Smith"},
        "chatHistory": [{"role": "user", "content": "hi", "timestamp": int(time.time())}],
    }


def send(client: httpx.Client, body: dict):
    r = client.post(f"{BASE_URL}/generateResponse", json=body, timeout=90.0)
    try:
        return r.status_code, r.json(), r.headers
    except ValueError:
        return r.status_code, r.text[:500], r.headers


def _err_text(data) -> str:
    if isinstance(data, dict) and data.get("error"):
        return str(data["error"])
    return "-"


def run_case(client: httpx.Client, label: str, body: dict) -> str:
    """Send one case (with a unique message), retrying once on a 429 after its retryAfter. Returns the label."""
    body = uniquify(body)
    print("\n" + "=" * 72)
    print(f"CASE: {label}")
    print("-" * 72)
    print("REQUEST:")
    print(mask(body))
    status, data, headers = send(client, body)
    result = classify(status, data)
    if result == "RATE_LIMIT":
        wait = retry_after_of(data, headers) + 1
        print(f"\nHTTP {status}  [RATE_LIMIT]  error={_err_text(data)}  → waiting {wait:.0f}s and retrying once")
        time.sleep(wait)
        body = uniquify(body)  # fresh unique text for the retry too
        status, data, headers = send(client, body)
        result = classify(status, data)
    print(f"\nHTTP {status}  [{result}]  error={_err_text(data)}")
    print("RESPONSE:")
    print(json.dumps(data, ensure_ascii=False, indent=2) if isinstance(data, (dict, list)) else str(data))
    time.sleep(INTER_REQUEST_SLEEP)
    return result


ALL_PANEL = "ALL panel fields (= what we send)"


def sweep_platform(client: httpx.Client, base: dict) -> None:
    """Vary ONLY `platform` on the known-good Playground baseline to find which values Capitalbot accepts."""
    results: dict[str, str] = {}
    for value in PLATFORM_CANDIDATES:
        body = copy.deepcopy(base)
        if value is None:
            body.pop("platform", None)
            label = "(platform omitted)"
        else:
            body["platform"] = value
            label = repr(value)
        results[label] = run_case(client, f"platform = {label}", body)

    print("\n" + "#" * 72)
    print("PLATFORM SWEEP VERDICT")
    print("#" * 72)
    for label, result in results.items():
        print(f"  [{result:10}]  platform = {label}")
    ok = [label for label, result in results.items() if result == "OK"]
    throttled = [label for label, result in results.items() if result == "RATE_LIMIT"]
    if ok:
        print(f"\nUse this platform value: {ok[0]}  (first accepted, ordered best-fit for Telegram)")
    else:
        print("\nNo candidate returned OK — widen PLATFORM_CANDIDATES and re-run.")
    if throttled:
        print(f"Inconclusive (still rate-limited after one retry): {', '.join(throttled)} — re-run to retest these.")


def run_field_diag(client: httpx.Client, base: dict, parts: dict, run_no: int) -> dict[str, str]:
    """One full per-field pass. Returns {case label: result label}."""
    print("\n" + "*" * 72)
    print(f"PER-FIELD RUN {run_no}")
    print("*" * 72)
    single_swaps = {
        "accountId → panel": {"accountId": parts["accountId"]},
        "platform → panel": {"platform": parts["platform"]},
        "userInfos → panel": {"userInfos": parts["userInfos"]},
        "chatHistory → panel (real history for this chat)": {"chatHistory": parts["chatHistory"]},
    }
    if parts["overrides"]:
        single_swaps["+ persona overrides (extra fields)"] = parts["overrides"]

    results: dict[str, str] = {"PLAYGROUND baseline": run_case(client, "PLAYGROUND baseline (expected OK)", copy.deepcopy(base))}
    for label, swap in single_swaps.items():
        body = copy.deepcopy(base)
        body.update(copy.deepcopy(swap))
        results[label] = run_case(client, label, body)

    full = copy.deepcopy(base)
    full.update(
        {
            "accountId": parts["accountId"],
            "platform": parts["platform"],
            "userInfos": parts["userInfos"],
            "chatHistory": parts["chatHistory"],
        }
    )
    full.update(parts["overrides"])
    results[ALL_PANEL] = run_case(client, ALL_PANEL, full)
    return results


async def main() -> None:
    settings = get_settings()
    import os

    license_key = os.environ.get("CAPITAL_LICENSE_KEY") or settings.capital_license_key
    if not license_key:
        raise SystemExit("CAPITAL_LICENSE_KEY is not set in the environment or settings.")

    base = playground_base(license_key)

    if SWEEP_PLATFORM:
        with httpx.Client() as client:
            if run_case(client, "PLAYGROUND baseline (expected OK)", copy.deepcopy(base)) != "OK":
                print("\nBaseline itself was not OK — fix that before trusting the sweep.")
            sweep_platform(client, base)
        return

    parts = await panel_request_parts(license_key)
    runs: list[dict[str, str]] = []
    with httpx.Client() as client:
        for n in range(1, RUNS + 1):
            runs.append(run_field_diag(client, base, parts, n))

    print("\n" + "#" * 72)
    print(f"VERDICT over {len(runs)} run(s)")
    print("#" * 72)
    labels = list(runs[0].keys())
    for label in labels:
        seq = [r[label] for r in runs]
        print(f"  {label}")
        print(f"      {' → '.join(seq)}")

    all_seq = [r[ALL_PANEL] for r in runs]
    print("\nALL panel fields (= what we send):")
    if all(x == "OK" for x in all_seq):
        print("  → consistently OK. Our request shape is accepted; earlier errors were 429 rate-limiting.")
    elif all(is_real_reject(x) for x in all_seq):
        print("  → consistently REJECTED. A field we send is genuinely refused (see per-field rows above).")
    else:
        print(f"  → INCONSISTENT ({', '.join(all_seq)}). Mix of OK/429/error → rate-limiting or a flaky 500, not a field problem.")

    # Which fields look like real rejections across runs (ignoring 429s)?
    culprits = [
        label
        for label in labels
        if label not in (ALL_PANEL, "PLAYGROUND baseline") and any(is_real_reject(r[label]) for r in runs)
    ]
    if culprits:
        print(f"\nFields that produced a real (non-429) rejection in at least one run: {', '.join(culprits)}")


if __name__ == "__main__":
    asyncio.run(main())
