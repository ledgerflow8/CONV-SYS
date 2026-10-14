"""The glue between the DB, the crypto and the AccountManager. Routes call this; it owns no
Telegram logic of its own (that's AccountManager / tg/) and no HTTP (that's routes/)."""

import asyncio
import logging
from datetime import datetime
from pathlib import Path

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from panel.accounts import AccountManager
from panel.crypto import Crypto
from panel.models import Account, Activity, utcnow
from panel.tg.client import AccountInfo, ConnectParams, TgError

log = logging.getLogger("panel.service")


class Service:
    def __init__(
        self,
        sessionmaker: async_sessionmaker[AsyncSession],
        crypto: Crypto,
        manager: AccountManager,
        data_dir: Path,
        default_api_id: int | None,
        default_api_hash: str | None,
    ):
        self.sessionmaker = sessionmaker
        self.crypto = crypto
        self.manager = manager
        self.avatar_dir = data_dir / "avatars"
        self.avatar_dir.mkdir(parents=True, exist_ok=True)
        self.default_api_id = default_api_id
        self.default_api_hash = default_api_hash
        self.import_gap_seconds = 2.0  # pause between test-connects so a batch isn't a login flood

    # ── helpers ────────────────────────────────────────────────────────────
    def connect_params(self, acc: Account, session_string: str | None = None) -> ConnectParams:
        return ConnectParams(
            session=session_string if session_string is not None else self.crypto.decrypt(acc.session_enc),
            api_id=acc.api_id,
            api_hash=acc.api_hash,
            device_model=acc.device_model,
            system_version=acc.system_version,
            app_version=acc.app_version,
            lang_code=acc.lang_code,
            system_lang_code=acc.system_lang_code,
        )

    async def log_activity(self, session: AsyncSession, level: str, kind: str, message: str, account_id: int | None = None) -> None:
        session.add(Activity(level=level, kind=kind, message=message[:1000], account_id=account_id))

    async def _on_drop(self, account_id: int, err: TgError | None) -> None:
        """Called by AccountManager when a live connection drops on its own (ban, revoke, network)."""
        async with self.sessionmaker() as session:
            acc = await session.get(Account, account_id)
            if not acc:
                return
            if err and err.dead:
                acc.status, acc.status_detail = err.status, err.detail
                acc.power_on = False  # a dead session won't come back by reconnecting
                await self.log_activity(session, "error", "account_dropped", f"@{acc.username}: {err.detail}", account_id)
            else:
                acc.status = "offline"
                acc.status_detail = err.detail if err else None
            acc.updated_at = utcnow()
            await session.commit()

    def on_drop(self):
        return self._on_drop

    # ── avatars ────────────────────────────────────────────────────────────
    async def refresh_avatar(self, account_id: int) -> None:
        client = self.manager.get(account_id)
        if not client:
            return
        path = self.avatar_dir / f"{account_id}.jpg"
        if await client.download_avatar(path):
            async with self.sessionmaker() as session:
                acc = await session.get(Account, account_id)
                if acc:
                    acc.avatar_path = str(path)
                    await session.commit()

    # ── lifecycle (step 5 adds the health loop; step 0/1 need startup connect) ──
    async def connect_powered_on(self) -> None:
        """On startup, connect accounts whose power is on. Staggered, so a batch doesn't look
        like a login flood from one IP."""
        async with self.sessionmaker() as session:
            rows = (await session.scalars(select(Account).where(Account.power_on.is_(True)))).all()
            targets = [(a.id, self.connect_params(a)) for a in rows if a.status not in ("banned", "revoked")]
        for account_id, params in targets:
            try:
                info = await self.manager.connect(account_id, params, self.on_drop())
                await self._mark_online(account_id, info)
                asyncio.create_task(self.refresh_avatar(account_id))
            except TgError as e:
                await self._mark_status(account_id, e.status, e.detail, power_off=e.dead)
            except Exception:
                log.exception("startup connect failed for %s", account_id)
            await asyncio.sleep(1.0)

    async def _mark_online(self, account_id: int, info: AccountInfo) -> None:
        async with self.sessionmaker() as session:
            acc = await session.get(Account, account_id)
            if acc:
                acc.status, acc.status_detail = "online", None
                if info.username:
                    acc.username = info.username
                if info.phone:
                    acc.phone = info.phone
                acc.first_name = info.first_name
                acc.updated_at = utcnow()
                await session.commit()

    async def _mark_status(self, account_id: int, status: str, detail: str | None, power_off: bool = False) -> None:
        async with self.sessionmaker() as session:
            acc = await session.get(Account, account_id)
            if acc:
                acc.status, acc.status_detail = status, detail
                if power_off:
                    acc.power_on = False
                acc.updated_at = utcnow()
                await session.commit()
