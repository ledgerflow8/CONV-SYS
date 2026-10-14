"""Import jobs: test each candidate session and save the working ones.

Runs as a background task. Candidates are tested one at a time with a small gap, so a big batch
doesn't trigger a login flood from the VPS IP (PLAN.md §10.7).
"""

import asyncio
import json
import logging

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from panel.collect import Candidate
from panel.models import Account, ImportItem, ImportJob, utcnow
from panel.service import Service
from panel.tg.client import TgError
from panel.tg.meta import AccountMeta, parse_meta
from panel.tg.sessions import ParsedSession, SessionFileError, parse_session

log = logging.getLogger("panel.importer")




async def _save_working(service: Service, session: AsyncSession, parsed: ParsedSession, meta: AccountMeta, info, client) -> Account:
    api_id = meta.api_id or service.default_api_id
    api_hash = meta.api_hash or service.default_api_hash
    acc = Account(
        tg_user_id=info.user_id,
        username=info.username,
        phone=info.phone or meta.phone,
        first_name=info.first_name,
        session_enc=service.crypto.encrypt(client.session_string()),
        auth_key_sha256=parsed.key_sha256,
        api_id=api_id,
        api_hash=api_hash,
        device_model=meta.device_model,
        system_version=meta.system_version,
        app_version=meta.app_version,
        lang_code=meta.lang_code,
        system_lang_code=meta.system_lang_code,
        twofa_enc=service.crypto.encrypt(meta.twofa) if meta.twofa else None,
        proxy_enc=service.crypto.encrypt(json.dumps(meta.proxy)) if meta.proxy else None,
        power_on=True,
        ai_on=False,
        status="online",
    )
    session.add(acc)
    await session.flush()  # assigns acc.id
    return acc


async def _process_one(service: Service, item_id: int, cand: Candidate) -> None:
    async with service.sessionmaker() as session:
        item = await session.get(ImportItem, item_id)
        # 1. Parse the file.
        try:
            parsed = parse_session(cand.session)
        except SessionFileError as e:
            item.result, item.detail = "invalid", str(e)
            await session.commit()
            return

        # 2. Parse the optional .json.
        meta = AccountMeta()
        if cand.meta_error:
            item.detail = cand.meta_error  # keep going with defaults
        elif cand.meta is not None:
            try:
                meta = parse_meta(cand.meta)
            except ValueError as e:
                item.detail = str(e)

        # 3. Need an api_id/api_hash from somewhere.
        if not (meta.api_id or service.default_api_id) or not (meta.api_hash or service.default_api_hash):
            item.result = "invalid"
            item.detail = "no api_id/api_hash in the .json and no panel default set (TG_API_ID/TG_API_HASH)"
            await session.commit()
            return

        # 4. Fast duplicate check by auth key, before connecting.
        dup = await session.scalar(select(Account).where(Account.auth_key_sha256 == parsed.key_sha256))
        if dup:
            item.result, item.detail = "duplicate", f"already added as @{dup.username}" if dup.username else "already added"
            item.username = dup.username
            await session.commit()
            return
        await session.commit()

    # 5. Connect and identify (outside the DB session; this is the slow part).
    from panel.tg.client import ConnectParams

    params = ConnectParams(
        session=parsed.string,
        api_id=meta.api_id or service.default_api_id,
        api_hash=meta.api_hash or service.default_api_hash,
        device_model=meta.device_model,
        system_version=meta.system_version,
        app_version=meta.app_version,
        lang_code=meta.lang_code,
        system_lang_code=meta.system_lang_code,
    )
    client = None
    try:
        info, client = await service.manager.test(params)
    except TgError as e:
        async with service.sessionmaker() as session:
            item = await session.get(ImportItem, item_id)
            item.result, item.detail = ("dead", e.detail)
            await session.commit()
        return

    # 6. Save, and adopt the live connection. Guard against a duplicate that appeared meanwhile
    #    (same account in the batch twice, by user id or auth key).
    async with service.sessionmaker() as session:
        item = await session.get(ImportItem, item_id)
        existing = await session.scalar(
            select(Account).where((Account.tg_user_id == info.user_id) | (Account.auth_key_sha256 == parsed.key_sha256))
        )
        if existing:
            item.result = "duplicate"
            item.detail = f"already added as @{existing.username}" if existing.username else "already added"
            item.username = existing.username
            await session.commit()
            await client.disconnect()
            return
        acc = await _save_working(service, session, parsed, meta, info, client)
        account_id, username, phone = acc.id, acc.username, acc.phone
        item.result, item.username, item.phone = "connected", username, phone
        await session.commit()

    await service.manager.adopt(account_id, client, service.on_drop())
    asyncio.create_task(service.refresh_avatar(account_id))


async def run_job(service: Service, job_id: str, candidates: list[Candidate]) -> None:
    item_ids: list[int] = []
    async with service.sessionmaker() as session:
        for cand in candidates:
            it = ImportItem(job_id=job_id, filename=cand.name[:255])
            session.add(it)
            await session.flush()
            item_ids.append(it.id)
        await session.commit()

    for item_id, cand in zip(item_ids, candidates):
        try:
            await _process_one(service, item_id, cand)
        except Exception as e:
            log.exception("import item failed")
            async with service.sessionmaker() as session:
                it = await session.get(ImportItem, item_id)
                if it and it.result == "pending":
                    it.result, it.detail = "dead", f"unexpected error: {type(e).__name__}"
                    await session.commit()
        await asyncio.sleep(service.import_gap_seconds)

    async with service.sessionmaker() as session:
        job = await session.get(ImportJob, job_id)
        if job:
            job.done = True
            await session.commit()
