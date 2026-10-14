"""The panel service: FastAPI + (from step 1) the Telethon AccountManager, in one process.

Run with exactly one worker: uvicorn --factory panel.main:create_app --workers 1
"""

from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from panel.accounts import AccountManager
from panel.auth import LoginLimiter, Signer
from panel.config import Settings, get_settings
from panel.crypto import Crypto
from panel.db import init_db, make_engine, make_sessionmaker
from panel.lock import InstanceLock
from panel.routes import accounts as account_routes
from panel.routes import auth as auth_routes
from panel.routes import imports as import_routes
from panel.service import Service
from panel.tg.client import ClientFactory, telethon_factory

DIST = Path(__file__).resolve().parent.parent / "frontend" / "dist"
SAFE_METHODS = {"GET", "HEAD", "OPTIONS"}
CSP = (
    "default-src 'self'; img-src 'self' data: blob:; style-src 'self'; script-src 'self'; "
    "connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'"
)


def create_app(settings: Settings | None = None, dist: Path = DIST, client_factory: ClientFactory | None = None) -> FastAPI:
    settings = settings or get_settings()

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        lock = InstanceLock(settings.lock_path)
        lock.acquire()  # raises AlreadyRunning: a second process must never hold the sessions
        engine = make_engine(settings.db_path)
        try:
            await init_db(engine)
            sessionmaker = make_sessionmaker(engine)
            app.state.sessionmaker = sessionmaker
            manager = AccountManager(client_factory or telethon_factory)
            app.state.manager = manager
            app.state.service = Service(
                sessionmaker,
                app.state.crypto,
                manager,
                settings.data_dir,
                settings.tg_api_id,
                settings.tg_api_hash,
            )
            app.state.background = set()
            await app.state.service.connect_powered_on()
            try:
                yield
            finally:
                await manager.shutdown()  # disconnect every client; never log out
                for task in list(app.state.background):
                    task.cancel()
        finally:
            await engine.dispose()
            lock.release()

    app = FastAPI(lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None)
    app.state.settings = settings
    app.state.crypto = Crypto(settings.panel_enc_key)  # fail at startup on a bad key
    app.state.signer = Signer(settings.panel_secret)
    app.state.limiter = LoginLimiter()

    @app.middleware("http")
    async def guard(request: Request, call_next):
        path = request.url.path
        # CSRF: mutating API calls must carry a custom header, which a cross-site form can't send.
        if path.startswith("/api/") and request.method not in SAFE_METHODS and request.headers.get("x-panel") != "1":
            return JSONResponse({"detail": "Missing X-Panel header"}, status_code=403)
        response = await call_next(request)
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["X-Frame-Options"] = "DENY"
        response.headers["Referrer-Policy"] = "same-origin"
        response.headers["Content-Security-Policy"] = CSP
        if path.startswith("/api/"):
            response.headers["Cache-Control"] = "no-store"
        return response

    app.include_router(auth_routes.router)
    app.include_router(account_routes.router)
    app.include_router(import_routes.router)

    @app.get("/healthz")
    async def healthz(request: Request) -> dict:
        manager = getattr(request.app.state, "manager", None)
        return {"ok": True, "accounts_online": manager.online_count if manager else 0}

    @app.api_route("/api/{rest:path}", methods=["GET", "POST", "PATCH", "PUT", "DELETE"], include_in_schema=False)
    async def api_not_found(rest: str) -> JSONResponse:
        return JSONResponse({"detail": "Not found"}, status_code=404)

    if (dist / "index.html").is_file():
        app.mount("/assets", StaticFiles(directory=dist / "assets"), name="assets")

        @app.get("/{rest:path}", include_in_schema=False)
        async def spa(rest: str) -> FileResponse:
            f = (dist / rest).resolve()
            if rest and f.is_file() and f.is_relative_to(dist.resolve()):
                return FileResponse(f)
            return FileResponse(dist / "index.html", headers={"Cache-Control": "no-cache"})

    return app

