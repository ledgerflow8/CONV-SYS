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

MODEL_ID = 3073
PRESET_ID = 6823

# platform `/generateResponse` accepts is not reliably documented; "Telegram" 500s for us. Sweep these,
# ordered by how well each fits a Telegram chat (Telegram links are always clickable, same as "Web").
PLATFORM_CANDIDATES = ["telegram", "Telegram", "TELEGRAM", "Web", "web", "Snapchat", "Instagram", None]


def mask(body: dict) -> str:
    safe = {k: ("***" if k == "licensekey" else v) for k, v in body.items()}
    return json.dumps(safe, ensure_ascii=False, indent=2)


def is_error(status: int, data) -> bool:
    if status != 200:
        return True
    if isinstance(data, dict) and isinstance(data.get("error"), str) and data["error"].strip():
        return True
    return False


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


def send(client: httpx.Client, body: dict) -> tuple[int, object]:
    r = client.post(f"{BASE_URL}/generateResponse", json=body, timeout=90.0)
    try:
        return r.status_code, r.json()
    except ValueError:
        return r.status_code, r.text[:500]


def run_case(client: httpx.Client, label: str, body: dict) -> bool:
    print("\n" + "=" * 72)
    print(f"CASE: {label}")
    print("-" * 72)
    print("REQUEST:")
    print(mask(body))
    status, data = send(client, body)
    err = is_error(status, data)
    print(f"\nHTTP {status}  →  {'ERROR' if err else 'OK'}")
    print("RESPONSE:")
    print(json.dumps(data, ensure_ascii=False, indent=2) if isinstance(data, (dict, list)) else str(data))
    return err


def sweep_platform(client: httpx.Client, base: dict) -> None:
    """Vary ONLY `platform` on the known-good Playground baseline to find which values Capitalbot accepts."""
    results: dict[str, bool] = {}
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
    for label, err in results.items():
        print(f"  {'ERROR' if err else 'OK   '}  platform = {label}")
    ok = [label for label, err in results.items() if not err]
    if ok:
        print(f"\nUse this platform value: {ok[0]}  (first accepted, ordered best-fit for Telegram)")
    else:
        print("\nNo candidate was accepted — widen PLATFORM_CANDIDATES and re-run.")


async def main() -> None:
    settings = get_settings()
    import os

    license_key = os.environ.get("CAPITAL_LICENSE_KEY") or settings.capital_license_key
    if not license_key:
        raise SystemExit("CAPITAL_LICENSE_KEY is not set in the environment or settings.")

    base = playground_base(license_key)

    if SWEEP_PLATFORM:
        with httpx.Client() as client:
            base_err = run_case(client, "PLAYGROUND baseline (expected OK)", copy.deepcopy(base))
            if base_err:
                print("\nBaseline itself errored — fix that before trusting the sweep.")
            sweep_platform(client, base)
        return

    parts = await panel_request_parts(license_key)

    # Each variant = the Playground baseline with exactly ONE field swapped to the panel's real value.
    single_swaps = {
        "accountId → panel": {"accountId": parts["accountId"]},
        "platform → panel": {"platform": parts["platform"]},
        "userInfos → panel": {"userInfos": parts["userInfos"]},
        "chatHistory → panel (real history for this chat)": {"chatHistory": parts["chatHistory"]},
    }
    if parts["overrides"]:
        single_swaps["+ persona overrides (extra fields)"] = parts["overrides"]

    with httpx.Client() as client:
        base_err = run_case(client, "PLAYGROUND baseline (expected OK)", copy.deepcopy(base))

        results: dict[str, bool] = {}
        for label, swap in single_swaps.items():
            body = copy.deepcopy(base)
            body.update(copy.deepcopy(swap))
            results[label] = run_case(client, label, body)

        # Everything swapped = what the panel actually sends.
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
        results["ALL panel fields (= what we send)"] = run_case(client, "ALL panel fields (= what we send)", full)

    print("\n" + "#" * 72)
    print("VERDICT")
    print("#" * 72)
    print(f"Playground baseline: {'ERROR (unexpected — check license/model/preset)' if base_err else 'OK'}")
    culprits = [label for label, err in results.items() if err and 'ALL panel' not in label]
    for label, err in results.items():
        print(f"  {'ERROR' if err else 'OK   '}  {label}")
    if culprits:
        print(f"\nFirst field that triggers the error: {culprits[0]}")
    elif results.get("ALL panel fields (= what we send)"):
        print("\nNo single field reproduces it, but all-together does — it's a combination.")
    else:
        print("\nNothing reproduced the error this run (the chat may have changed, or it was transient).")


if __name__ == "__main__":
    asyncio.run(main())
