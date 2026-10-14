import asyncio
import secrets

from fastapi import APIRouter, Depends, HTTPException, Request, UploadFile
from sqlalchemy import select

from panel.auth import require_login
from panel.collect import TooLarge, collect
from panel.importer import run_job
from panel.models import ImportItem, ImportJob

router = APIRouter(prefix="/api/imports", dependencies=[Depends(require_login)])

MAX_UPLOAD_BYTES = 60 * 1024 * 1024
MAX_FILES = 600
ALLOWED_EXT = (".session", ".json", ".zip")


@router.post("")
async def create_import(request: Request, files: list[UploadFile]) -> dict:
    if not files:
        raise HTTPException(400, "No files uploaded")
    if len(files) > MAX_FILES:
        raise HTTPException(400, f"At most {MAX_FILES} files at once")

    total = 0
    payload: list[tuple[str, bytes]] = []
    for f in files:
        name = f.filename or "upload"
        if not name.lower().endswith(ALLOWED_EXT):
            continue  # ignore stray files the picker let through
        data = await f.read()
        total += len(data)
        if total > MAX_UPLOAD_BYTES:
            raise HTTPException(413, "Upload is larger than 60 MB")
        payload.append((name, data))
    if not payload:
        raise HTTPException(400, "No .session, .json or .zip files found")

    try:
        collected = collect(payload)
    except TooLarge as e:
        raise HTTPException(413, str(e)) from e
    except ValueError as e:
        raise HTTPException(400, str(e)) from e

    if not collected.candidates and not collected.invalid:
        raise HTTPException(400, "No session files found in the upload")

    service = request.app.state.service
    job_id = secrets.token_hex(12)
    async with service.sessionmaker() as session:
        session.add(ImportJob(id=job_id))
        for name, reason in collected.invalid:
            session.add(ImportItem(job_id=job_id, filename=name[:255], result="invalid", detail=reason))
        await session.commit()

    task = asyncio.create_task(run_job(service, job_id, collected.candidates))
    request.app.state.background.add(task)
    task.add_done_callback(request.app.state.background.discard)
    return {"job_id": job_id, "candidates": len(collected.candidates), "invalid": len(collected.invalid)}


@router.get("/{job_id}")
async def get_import(job_id: str, request: Request) -> dict:
    async with request.app.state.service.sessionmaker() as session:
        job = await session.get(ImportJob, job_id)
        if not job:
            raise HTTPException(404, "No such import")
        items = (await session.scalars(select(ImportItem).where(ImportItem.job_id == job_id).order_by(ImportItem.id))).all()
    results = [
        {"filename": it.filename, "result": it.result, "detail": it.detail, "username": it.username, "phone": it.phone}
        for it in items
    ]
    done_count = sum(1 for it in items if it.result != "pending")
    return {
        "done": job.done,
        "total": len(items),
        "processed": done_count,
        "results": results,
    }
