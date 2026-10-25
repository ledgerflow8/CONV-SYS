"""CLI: python -m panel gen-key | set-password | disk | recover --since <ISO time UTC> [--apply]

  disk      What fills DATA_DIR (read-only).
  recover   Ask the RUNNING panel (on this machine) to re-scan chats since a time and queue missing
            convo events. Without --apply it's a dry run that only reports. It never connects to
            Telegram itself: the panel's own connections do the reading.
"""

import asyncio
import getpass
import sys

from panel.crypto import generate_key


async def _set_password(password: str) -> None:
    from panel.auth import store_password
    from panel.config import get_settings
    from panel.db import init_db, make_engine, make_sessionmaker

    engine = make_engine(get_settings().db_path)
    try:
        await init_db(engine)
        async with make_sessionmaker(engine)() as session:
            await store_password(session, password)
            await session.commit()
    finally:
        await engine.dispose()


def _mb(n: int) -> str:
    return f"{n / (1024 * 1024):,.1f} MB"


def _disk() -> int:
    import sqlite3

    from panel.config import get_settings
    from panel.housekeeping import disk_usage

    data_dir = get_settings().data_dir
    u = disk_usage(data_dir)
    print(f"{data_dir}: {u['used_pct']}% used, {_mb(u['used_bytes'])} of {_mb(u['total_bytes'])}, {_mb(u['free_bytes'])} free")
    for k, v in u["breakdown"].items():
        print(f"  {k:14} {_mb(v)}")
    db = data_dir / "panel.db"
    if db.is_file():
        con = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
        try:
            for t in ("messages", "outbox", "activity", "chats", "leads", "import_items"):
                print(f"  rows {t:10} {con.execute(f'SELECT count(*) FROM {t}').fetchone()[0]:,}")
            page = con.execute("PRAGMA page_size").fetchone()[0]
            free = con.execute("PRAGMA freelist_count").fetchone()[0]
            print(f"  reusable free space inside panel.db: {_mb(page * free)}")
        finally:
            con.close()
    return 0


def _recover(args: list[str]) -> int:
    import os
    import sqlite3
    import time

    import httpx

    from panel.auth import COOKIE, Signer
    from panel.config import get_settings

    if "--since" not in args or args.index("--since") + 1 >= len(args):
        print("Usage: python -m panel recover --since 2026-10-25T15:30:00Z [--apply]", file=sys.stderr)
        return 2
    since = args[args.index("--since") + 1]
    apply = "--apply" in args
    settings = get_settings()
    con = sqlite3.connect(f"file:{settings.db_path}?mode=ro", uri=True)
    try:
        row = con.execute("SELECT value FROM settings WHERE key = 'session_epoch'").fetchone()
    finally:
        con.close()
    epoch = int(row[0]) if row else 0
    cookie = Signer(settings.panel_secret).make(epoch)  # same login the browser holds
    base = f"http://127.0.0.1:{os.environ.get('PORT', '10000')}/api/system/recover"
    with httpx.Client(cookies={COOKIE: cookie}, headers={"X-Panel": "1"}, timeout=30) as c:
        r = c.post(base, json={"since": since, "dry_run": not apply})
        if r.status_code != 200:
            print(f"Panel refused: {r.status_code} {r.text}", file=sys.stderr)
            return 1
        print(("Recovering" if apply else "Dry run") + f" since {since} …")
        while True:
            job = c.get(base).json()["recovery"]
            print(f"  {job['accounts_done']}/{job['accounts_total']} accounts", end="\r", flush=True)
            if not job["running"]:
                break
            time.sleep(3)
    print()
    t = job["totals"]
    print(f"Chats scanned: {t['chats_scanned']}  messages restored: {t['messages_restored']}")
    print(f"Missing events {'queued' if apply else 'that would be queued'}: {t['first_events']} new convos, {t['reply_events']} replies")
    print(f"Chats whose last message is the fan's (no reply yet): {t['unanswered']}")
    for a in job["accounts"]:
        if a["error"]:
            print(f"  @{a['username'] or a['account_id']}: {a['error']}")
    if job["error"]:
        print(f"Error: {job['error']}", file=sys.stderr)
        return 1
    if not apply:
        print("Nothing was changed. Re-run with --apply to queue them.")
    return 0


def main(argv: list[str]) -> int:
    cmd = argv[1] if len(argv) > 1 else ""
    if cmd == "gen-key":
        print(generate_key())
        return 0
    if cmd == "set-password":
        pw = getpass.getpass("New panel password: ")
        if pw != getpass.getpass("Again: "):
            print("Passwords don't match.", file=sys.stderr)
            return 1
        try:
            asyncio.run(_set_password(pw))
        except ValueError as e:
            print(e, file=sys.stderr)
            return 1
        print("Password set. Every existing login was signed out.")
        return 0
    if cmd == "disk":
        return _disk()
    if cmd == "recover":
        return _recover(argv[2:])
    print(__doc__, file=sys.stderr)
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv))
