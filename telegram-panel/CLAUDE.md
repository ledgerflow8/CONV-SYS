# CLAUDE.md — Telegram Panel

Read `PLAN.md` (this folder) before doing anything. It is the source of truth for scope, data model, routes, screens and build order. The API reference is `CapitalAI_Docs.md`.

## Project
A standalone panel that holds the client's Telegram accounts: it connects each account, lets Capitalbot AI chat on it, and reports convos to the VA portal (the Next.js site one folder up). It deploys on its own as a Render Web Service and never imports code from the portal.

## Stack
Python 3.12, FastAPI + Telethon in one asyncio process, SQLite (WAL) through SQLAlchemy 2 (async), React + Vite frontend (plain JSX) built to `frontend/dist` and served by FastAPI. pytest. Deployed as one Render Web Service (single instance, persistent disk).

## Rules
- **One Telegram connection per account, held by this panel.** Exactly one process (uvicorn `--workers 1`, plus the `data/panel.lock` lock file at startup) and one `TelegramClient` per account. Uploading a session that's already in the panel never opens a second client for it.
- **Never log an account out except on Delete.** Shutdown, power off, a failed test or a dead session only disconnect.
- **Secrets are encrypted at rest:** session strings, 2FA passwords and proxy credentials use Fernet with `PANEL_ENC_KEY`. Uploaded `.session`, `.json` and `.zip` files are read in a temp dir and deleted. Raw files are never kept.
- **Never commit** `.env`, `*.session`, `*.zip`, the `data/` dir or any `*.db`/`*.sqlite*`. Check `git status` before every commit.
- **Portal contract is fixed.** Convo events match the portal's `convoEventSchema` (`src/lib/ingest.ts`) and its auth (`src/lib/ingest-auth.ts`): `Authorization: Bearer`, `X-Timestamp`, `X-Signature: sha256=HMAC(secret, "<ts>.<raw body>")`. Sign at send time, never at enqueue time. Times are ISO 8601 UTC with `Z`.
- **Everything bound for the portal goes through the outbox.** Never POST to the portal inline from a handler.
- **Every call to Capitalbot goes through `capital.py`.** Handle every empty-content flag (`converted`, `underage`, `timewaste`, `tierFiltered`, `genderFiltered`, `aiCreditOver`, `messagedAlready`, `internalAccount`, `ignored`, plus `ppvExhausted`, `chatCooldown`). An empty `content` with no flag is logged as a Capitalbot bug.
- **Every chatHistory message has a `timestamp`** in Unix seconds. Capitalbot `accountId` = the account's numeric Telegram id (string); portal `tgAccount` = its username.
- **Never send a reply twice.** No retry after a Capitalbot timeout or 5xx, and drop any reply if the chat was answered since the triggering fan message.
- **No branding** from Capitalbot or the reference product in the UI. Name it "Telegram Panel" until the client gives a name.
- **Mobile-first UI**, matching the portal: cards, a floating menu button, a left drawer. Never use `alert`/`confirm`; use in-page dialogs.
- All routes except `/api/auth/login` and `/healthz` require the panel login (`Depends(require_login)`). Mutating `/api/*` calls must send `X-Panel: 1`; the frontend's `api.js` does it.
- The schema is created up front with `create_all`. Once the panel holds real accounts, any column change needs a migration (add Alembic the first time that happens).
- Deploy steps live in `DEPLOY.md`.
- Telethon is wrapped behind `tg/` so the logic (AI flow, event derivation, outbox) can be tested without Telegram.

## Commands
- Setup: `python3.12 -m venv .venv && .venv/bin/pip install -r requirements-dev.txt` (deps are pinned; edit `requirements*.in`, then `uv pip compile`)
- Dev backend: `.venv/bin/uvicorn --factory panel.main:create_app --reload --port 8080` (needs `.env`, see `.env.example`)
- Dev frontend: `cd frontend && npm run dev` (proxies `/api` to :8080)
- Frontend build (what FastAPI serves): `cd frontend && npm run build`
- Tests: `.venv/bin/pytest`
- Set the panel password: `python -m panel set-password`

## Decisions
All settled: see `PLAN.md` §10 (product) and §11 (Capitalbot). Don't reopen them; if something new comes up, pick the safest option and record it there.
