"""AccountManager: the one owner of live Telegram connections, one per account (CLAUDE.md).

Everything that connects, disconnects, tests or removes an account goes through here, so the
"exactly one connection per account" rule lives in a single place.
"""

import asyncio
import logging

from panel.tg.client import AccountInfo, ClientFactory, ConnectParams, TgClient, TgError, classify

log = logging.getLogger("panel.accounts")


class AccountManager:
    def __init__(self, factory: ClientFactory):
        self._factory = factory
        self._clients: dict[int, TgClient] = {}
        self._locks: dict[int, asyncio.Lock] = {}
        self._watchers: dict[int, asyncio.Task] = {}

    def _lock(self, account_id: int) -> asyncio.Lock:
        return self._locks.setdefault(account_id, asyncio.Lock())

    def is_connected(self, account_id: int) -> bool:
        return account_id in self._clients

    @property
    def online_count(self) -> int:
        return len(self._clients)

    def connected_items(self) -> list[tuple[int, "TgClient"]]:
        """A snapshot of (account_id, client) for every live connection."""
        return list(self._clients.items())

    async def test(self, params: ConnectParams) -> tuple[AccountInfo, TgClient]:
        """Connect a candidate during import. On success the SAME client is adopted as the live
        connection (adopt()), so a working session is never connected twice."""
        client = self._factory(params)
        return await client.start(), client

    async def adopt(self, account_id: int, client: TgClient, on_drop, on_message=None) -> None:
        """Keep an already-connected client as this account's live connection."""
        async with self._lock(account_id):
            if account_id in self._clients:
                # Already connected (e.g. a racing import): drop the newcomer, keep the holder.
                await client.disconnect()
                return
            if on_message is not None:
                client.on_private_message(on_message)
            self._clients[account_id] = client
            self._watchers[account_id] = asyncio.create_task(self._watch(account_id, client, on_drop))

    async def connect(self, account_id: int, params: ConnectParams, on_drop, on_message=None) -> AccountInfo:
        async with self._lock(account_id):
            if account_id in self._clients:
                raise TgError("error", "Account is already connected")
            client = self._factory(params)
            info = await client.start()  # raises TgError; nothing is stored on failure
            if on_message is not None:
                client.on_private_message(on_message)
            self._clients[account_id] = client
            self._watchers[account_id] = asyncio.create_task(self._watch(account_id, client, on_drop))
            return info

    async def disconnect(self, account_id: int) -> None:
        """Drop the connection but keep the session (never a log out)."""
        async with self._lock(account_id):
            await self._stop_watcher(account_id)
            client = self._clients.pop(account_id, None)
        if client:
            await client.disconnect()

    async def log_out_and_remove(self, account_id: int) -> None:
        """Delete only: ends the session on Telegram, then drops it."""
        async with self._lock(account_id):
            await self._stop_watcher(account_id)
            client = self._clients.pop(account_id, None)
        if client:
            try:
                await client.log_out()
            finally:
                await client.disconnect()

    def get(self, account_id: int) -> TgClient | None:
        return self._clients.get(account_id)

    async def shutdown(self) -> None:
        """Disconnect every client on service stop. Never logs anyone out."""
        ids = list(self._clients)
        for account_id in ids:
            await self._stop_watcher(account_id)
        clients = [self._clients.pop(i) for i in ids]
        await asyncio.gather(*(c.disconnect() for c in clients), return_exceptions=True)

    async def _stop_watcher(self, account_id: int) -> None:
        task = self._watchers.pop(account_id, None)
        if task:
            task.cancel()
            try:
                await task
            except (asyncio.CancelledError, Exception):
                pass

    async def _watch(self, account_id: int, client: TgClient, on_drop) -> None:
        """Resolve when the connection drops, then report why (banned/revoked/etc.) once."""
        try:
            err = await client.wait_disconnected()
        except asyncio.CancelledError:
            raise
        except Exception as e:
            err = classify(e)
        # A deliberate disconnect already removed the client under the lock; don't double-report.
        if self._clients.get(account_id) is not client:
            return
        self._clients.pop(account_id, None)
        self._watchers.pop(account_id, None)
        try:
            await on_drop(account_id, err)
        except Exception:
            log.exception("on_drop failed for account %s", account_id)
