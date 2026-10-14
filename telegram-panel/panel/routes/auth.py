from fastapi import APIRouter, Depends, HTTPException, Request, Response
from pydantic import BaseModel
from starlette.concurrency import run_in_threadpool

from panel.auth import COOKIE, COOKIE_MAX_AGE, require_login, verify_password
from panel.db import get_setting

router = APIRouter(prefix="/api/auth")


class LoginBody(BaseModel):
    password: str


@router.post("/login")
async def login(body: LoginBody, request: Request, response: Response) -> dict:
    state = request.app.state
    ip = request.client.host if request.client else "?"
    wait = state.limiter.retry_after(ip)
    if wait:
        raise HTTPException(429, f"Too many attempts. Try again in {wait // 60 + 1} min.")

    async with state.sessionmaker() as session:
        stored = await get_setting(session, "password_hash")
        epoch = int(await get_setting(session, "session_epoch", 0))
    if not stored:
        raise HTTPException(503, "No password set. On the server run: python -m panel set-password")

    if not await run_in_threadpool(verify_password, stored, body.password):
        state.limiter.fail(ip)
        raise HTTPException(401, "Wrong password")

    state.limiter.reset(ip)
    response.set_cookie(
        COOKIE,
        state.signer.make(epoch),
        max_age=COOKIE_MAX_AGE,
        httponly=True,
        secure=state.settings.secure_cookies,
        samesite="strict",
        path="/",
    )
    return {"ok": True}


@router.post("/logout")
async def logout(request: Request, response: Response) -> dict:
    response.delete_cookie(COOKIE, path="/", secure=request.app.state.settings.secure_cookies, samesite="strict")
    return {"ok": True}


@router.get("/me", dependencies=[Depends(require_login)])
async def me() -> dict:
    return {"ok": True}
