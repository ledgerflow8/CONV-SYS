"""CLI: python -m panel gen-key | set-password"""

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
    print(__doc__, file=sys.stderr)
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv))
