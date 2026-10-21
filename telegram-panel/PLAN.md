# Telegram Panel — Plan

## 1. Scope

One service on Render (a single Web Service with a persistent disk) that:

1. **Holds the client's Telegram accounts.** Each account has one live connection, which the client can switch on or off from a phone.
2. **Adds accounts** by uploading `.session` files (alone, paired with `.json` files, or in a `.zip`) or by phone login.
3. **Lets Capitalbot AI chat** on each account that has its chat toggle on. Incoming DMs go to `/generateResponse` and the replies are posted back.
4. **Reports to the portal** at its ingest endpoint: new convos, first replies and account status. Reports are queued and retried.
5. **Is private** behind its own login.

Out of scope for v1: openers (starting chats), group chats, a manual chat UI (the client uses the Telegram app for that), multiple panel users, and backfilling chats from before an account was added.

## 2. Architecture

```
 phone browser ──HTTPS──► Render (TLS, panel.fansflow.eu) ──► uvicorn :$PORT (1 instance, 1 worker)
                                           │
                                           ├─ FastAPI: /api/*  + static frontend/dist
                                           ├─ AccountManager: one TelegramClient per powered-on account
                                           │     └─ NewMessage handlers → chat store → AI worker
                                           ├─ AI worker: per-chat debounce → capital.py → send replies
                                           ├─ Outbox worker: signed batches → portal /api/ingest/convo
                                           └─ Health loop: status checks, "gone quiet", avatar refresh
                                           │
                                     SQLite (WAL) on the persistent disk ($DATA_DIR/panel.db)
```

- **One process, one event loop.** Telethon clients, the workers and FastAPI share the loop. A `fcntl` lock on `data/panel.lock` stops a second process from starting, so two processes can never hold the same session (Telegram kills sessions used from two places with `AuthKeyDuplicatedError`).
- **AccountManager** is the only owner of `TelegramClient` objects: `connect(id)`, `disconnect(id)`, `logout_and_remove(id)`, and `test_session(...)` for imports. On startup it connects powered-on accounts with a 1-second stagger.
- **Telethon wrapper (`panel/tg/`).** The rest of the code sees plain dataclasses (`IncomingMessage`, `PeerInfo`, `AccountInfo`), so tests run on a fake.
- **No websockets.** The frontend polls `GET /api/accounts` every 10s while the tab is visible, and works out "Xs ago" on the client.

### Folder layout

```
telegram-panel/
  panel/
    main.py            FastAPI app, lifespan (lock, DB, AccountManager, workers)
    config.py          env settings (pydantic-settings)
    db.py, models.py   SQLAlchemy async engine + tables
    crypto.py          Fernet encrypt/decrypt (MultiFernet for key rotation)
    auth.py            panel login, session cookie, rate limit
    tg/                Telethon wrapper: client factory, session import, errors → status
    accounts.py        AccountManager
    importer.py        .session/.json/.zip parsing + test jobs
    phone_login.py     pending phone logins
    capital.py         Capitalbot client + response handling
    ai.py              per-chat debounce, chatHistory builder, reply sender
    portal.py          event derivation + outbox worker + HMAC signing
    routes/            auth, accounts, imports, phone_login, profiles, system
    __main__.py        CLI: set-password, gen-key
  frontend/            Vite + React (JSX)
  tests/
  .env.example  .gitignore  requirements.txt  PLAN.md  CLAUDE.md
```

## 3. Data model (SQLite)

**accounts**
| column | notes |
|---|---|
| id | int pk |
| tg_user_id | bigint unique. Duplicate detection uses this, not the file name. Sent to Capitalbot as `accountId` (as a string) |
| username | lowercase, no `@`. Sent to the portal as `tgAccount` (the Pool matches on username) |
| phone, first_name | from `get_me()` |
| session_enc | Fernet(StringSession) |
| api_id, api_hash | from the `.json`, or the panel's own `TG_API_ID`/`TG_API_HASH` |
| device_model, system_version, app_version, lang_code, system_lang_code | from the `.json`, or defaults. Every reconnect uses the same values |
| twofa_enc | Fernet, nullable |
| proxy_enc | Fernet(JSON `{type, host, port, user, pass}`), nullable |
| power_on | bool. The client's connect toggle |
| ai_on | bool. The chat toggle |
| profile_id | fk → profiles, nullable (AI can't be switched on without one) |
| status | `offline` · `connecting` · `online` · `limited` (spam-restricted / flood) · `banned` · `revoked` · `error` |
| status_detail | last error text |
| last_msg_at, last_incoming_at | any direction / fan only |
| avatar_path | small JPEG in `data/avatars/` |
| created_at, updated_at | |

**Health colour** (worked out, not stored):
- **Red:** `banned`, `revoked` or `error`.
- **Grey:** powered off.
- **Amber:** `limited`, or online with no incoming message for `quiet_after_hours`.
- **Green:** online and active.

**profiles** (personas, shared by many accounts)
| column | notes |
|---|---|
| id, name | |
| capital_model_id, capital_preset_id | picked from `/getModelsAndPresets` |
| overrides | JSON, limited to the fields Capitalbot accepts: `modelName, modelAge, city, timezone, appearance, hobbies, ctaInfo, dayTimeActivity, nightTimeActivity, language, detectLanguage, photoRate, chattingStyle, interestLevel, phaseGoal, conversationSource, audio, video, image, matchLocation, affiliate` |

Per-account overrides: `accounts.profile_overrides` (JSON, same allowed keys) is merged over the profile. This covers "per account or per model".

**chats** — unique (account_id, peer_id)
| column | notes |
|---|---|
| peer_id | fan's Telegram user id (string) |
| peer_username, peer_name, peer_phone | phone in E.164 with `+` when Telegram shows it |
| first_in_at | the fan's first message (from Telegram history, not just what we saw) |
| first_reply_at | the account's first message at or after `first_in_at` (AI or manual) |
| reported_first, reported_reply | outbox enqueued |
| ai_state | `active` · `converted` · `stopped` (underage / timewaste / ppvExhausted) · `filtered` (tier/gender/ignored/messagedAlready/internal) |
| cooldown_until | from `chatCooldownUntil` |
| capital_conversation_id | when returned |
| media_uploads | JSON day counter, to stay under 5/min and 30/day |
| last_in_at, last_out_at | |

**messages** — unique (account_id, peer_id, tg_msg_id). Columns: `direction` (in/out), `sender` (`fan`/`ai`/`manual`), `kind` (`text`/`image`/`video`/`audio`/`gif`/`sticker`/`location`/`other`), `text`, `at`. Outgoing messages sent from the client's own phone are captured too (Telethon `NewMessage(outgoing=True)`). Rows older than 30 days are pruned.

**outbox**
| column | notes |
|---|---|
| id, kind | `convo` · `account_status` |
| dedupe_key | e.g. `convo:{account}:{peer}:reply`, unique while pending |
| payload | JSON, unsigned |
| status | `pending` · `sent` · `failed` (portal rejected it as invalid; needs a human) |
| attempts, next_attempt_at, last_error, created_at, sent_at | |

**import_jobs / import_items**: job id, the per-file result (`connected` + username + phone · `dead` + reason · `duplicate` + existing username · `invalid` + reason), created_at. Kept for 24h.

**activity**: a ring buffer of notable events (AI errors, flag hits, bans, portal failures) for the Status screen. Kept for 7 days.

**settings** (key/value):
- `quiet_after_hours` (12)
- `ai_debounce_sec` (8)
- `ai_global_on` (true, the kill switch)
- `followup` (off; see §10)
- `typing_cps` (typing speed for simulated delays)

## 4. Flows

### 4.1 Session upload
1. `POST /api/imports` (multipart, `files[]`). Accepts `.session`, `.json` and `.zip`. Limits: 50 MB total, 500 files. Zips are unpacked in a temp dir with zip-slip and size checks, and only `.session`/`.json` files are taken.
2. Files are paired by base name (`123.session` + `123.json`). A `.json` with no `.session` is reported as `invalid`.
3. **Session format detection**, from the SQLite schema:
   - **Telethon:** a `sessions(dc_id, server_address, port, auth_key)` table.
   - **Pyrogram:** a `sessions(dc_id, api_id, test_mode, auth_key, …)` table; the DC id is mapped to its address.
   - Either way it's converted to a Telethon `StringSession` in memory.
4. **JSON mapping** is tolerant of common key spellings: `app_id`/`api_id`, `app_hash`/`api_hash`, `device`/`device_model`, `sdk`/`system_version`, `app_version`, `lang_pack`/`lang_code`, `system_lang_pack`/`system_lang_code`, `twoFA`/`2fa`/`password`, `proxy`. Missing fields fall back to the panel defaults.
5. Each account is tested in turn: connect with those parameters, then `get_me()`, with a 20s timeout.
   - **Error → result:** `AuthKeyUnregistered`/`SessionRevoked` → `dead (revoked)`; `UserDeactivated`/`UserDeactivatedBan` → `dead (banned)`; timeout or network → `dead (unreachable)`, which can be retried.
   - **`tg_user_id` already in the panel** → disconnect the test client and report `duplicate`. It's never logged out, so the existing connection is untouched.
   - **Works** → encrypt, insert with `power_on=true, ai_on=false`, and keep that same client as the account's live connection (no second connect). Then fetch the avatar.
6. The frontend polls `GET /api/imports/{job}` and shows each result as it lands.

### 4.2 Phone login
`start(phone)` → `send_code_request`. The pending client and `phone_code_hash` stay in memory for 5 minutes, keyed by `login_id`. Then:
- `code` → `sign_in`.
- On `SessionPasswordNeeded` → `password` → `sign_in(password=…)`.
- Wrong code or password → retry, up to 3 tries.

On success the account is saved like an import. Phone logins use the panel's own `TG_API_ID`/`TG_API_HASH` and default device info.

### 4.3 Incoming message → AI
1. A private message from a non-bot, non-self user arrives and is stored in `messages`. It updates `last_*` and the chat row.
2. **New chat?** If `chats.first_in_at` is empty, fetch the oldest message in the dialog to get the real `first_in_at`. Enqueue a `convo` event (§4.4).
3. **Stop here unless** `ai_global_on`, `ai_on`, the account has a profile, `ai_state` is `active` or `converted`, and any `cooldown_until` has passed.
4. **Debounce:** wait `ai_debounce_sec` after the fan's last message, so a burst becomes one call. A new message restarts the timer. Only one call per chat can be in flight at a time.
5. **Build the request:**
   - `chatHistory`: the last 50 messages from the store, trimmed further if the JSON passes 200 KB. Fan messages get role `user`. Everything the account sent gets role `assistant`, whether the AI or the client wrote it (`bot` is never sent). Times are in Unix seconds, and media becomes a marker (`*IMAGE*`, `*VIDEO*`, `*AUDIO*`, `*GIF*`, `*STICKER*`, `*LOCATION*`). The history is what's actually on Telegram: an AI reply that failed to send isn't in it.
   - **Identity:** `platform: "Telegram"`, `accountId: str(tg_user_id)`, `userInfos: {useridentifier: peer_id, name, username}`.
   - **Persona:** the profile plus the account's overrides.
6. **Fan media in this batch:** upload one file per call: the newest image, video or voice note (≤ 50 MB), sent as multipart `file`. Any other media in the batch, and anything over the per-fan media limit, goes as a marker only.
7. **Call** with a 90s timeout. At most 10 Capitalbot calls are in flight across the panel.
   - **Retried once:** a connection that never opened (the request never left), and a `429` (10s later). In both cases Capitalbot didn't process the request.
   - **Never retried:** a timeout or `5xx`, since Capitalbot may already have generated a reply. These are logged to activity, and the fan's next message triggers a fresh call.
   - **`400`/`401`/`403`:** log to activity and pause the account's AI. Every Capitalbot error appears on Status and on the account card. Credits aren't tracked.
8. **Handle the response:**
   - **Already answered?** Before sending, check whether the account has posted anything since the fan message that triggered the call (the client typing by hand, or an earlier reply). If it has, the response is dropped and logged. This covers Capitalbot's "re-served pending responses" too: a reply is only ever sent to a chat that hasn't been answered.
   - **`content` present:** mark the chat read, then send each item in order. Show "typing…" for a time based on text length (capped at 6s). Images and videos go out with `send_file`. Audio is converted with ffmpeg to OGG/Opus and sent as a voice note; if conversion fails it goes as a plain audio file, and if that fails it's skipped and logged. An item is stored as `sender=ai` only after Telegram accepts it. Only `content` is read; the legacy `messages`/`media` fields are ignored.
   - **`converted`:** set `ai_state=converted`, but keep calling on future fan messages, because an un-convert brings back content (docs: conversions can be reversed). There are no timer calls: only a fan message triggers a call.
   - **`underage`:** set `ai_state=stopped` for good. The panel can't reset it.
   - **`timewaste` or `ppvExhausted`:** set `ai_state=stopped` and stop calling. The client can reset these.
   - **`tierFiltered`, `genderFiltered`, `ignored`, `messagedAlready` or `internalAccount`:** set `ai_state=filtered` and stop calling. This costs nothing, and the client can reset a chat.
   - **`chatCooldown`:** set `cooldown_until`.
   - **`aiCreditOver`:** pause all AI calls for 10 minutes and show a red banner.
   - **Empty with no flag:** send nothing, and log it as a Capitalbot bug with `conversationId` and the body.
   - **`conversationId`:** read from the top level, falling back to `statistics.conversationId`. It may be missing on the first exchange.

### 4.4 Portal events
Derivation matches the portal's `toConvoEvent`. **firstMsgAt** is the fan's first message; **repliedAt** is the account's first message at or after it, whether the AI or the client wrote it.

| when | event body |
|---|---|
| a new chat is detected | `{tgAccount, peerId, peerPhone?, firstMsgAt}` |
| first reply after `first_in_at` | `{tgAccount, peerId, peerPhone?, firstMsgAt, repliedAt}` |
| the phone becomes visible later | the same event again (ingest merges and never erases) |

`tgAccount` is the lowercase username. Times are ISO UTC (`2026-10-14T09:00:00Z`). `peerPhone` is in E.164 format.

**Outbox worker:**
1. Every 5s it takes up to 200 due rows of the same kind, builds `{"events":[…]}`, and signs it at send time:
   ```
   ts  = str(int(time.time()))
   sig = "sha256=" + hmac_sha256_hex(PORTAL_INGEST_HMAC_SECRET, f"{ts}.{raw_body}")
   headers: Authorization: Bearer PORTAL_INGEST_API_KEY, X-Timestamp: ts, X-Signature: sig, Content-Type: application/json
   ```
2. **Results:**
   - `200`: each row maps to `results[index]`. `ok:true` → `sent`; `ok:false` → `failed` with the error. This is a validation problem that a retry won't fix.
   - Network error, `5xx` or `413`: back off exponentially from 10s up to a 30-minute cap, and keep trying forever. A `413` halves the batch.
   - `401`/`503`: back off and show an alert on Status, since the config is wrong.
3. Its clock must be within ±5 minutes of the portal's; Render's hosts are NTP-synced, so no action is needed.

**Account status** (`kind=account_status`) is enqueued on every status change: `{tgAccount, status: online|offline|limited|banned|revoked, at, detail?}`. It goes to the new portal route `POST /api/ingest/account-status` (approved; built in step 2), which uses the same auth as convo ingest.

### 4.5 Health loop (every 60s)
- **Online accounts:** a cheap `get_me()` every 10 minutes. Errors map to statuses: auth errors → `revoked`, deactivation → `banned`, `PeerFlood`/`FloodWait` → `limited` (with the wait recorded).
- **Disconnected accounts** that should be on reconnect with backoff, unless they're banned or revoked.
- **Avatars** refresh once a day.

### 4.6 Power / chat / delete
- **Power off:** `disconnect()` and keep the session. While an account is off, no AI replies go out and no portal events are reported.
- **Power on:** connect.
- **Chat toggle:** sets `ai_on` only. Listening and portal reporting carry on regardless.
- **Delete:** an in-page dialog where the client types the username → `log_out()` (ends the session on Telegram) → delete the account, its chats and its messages. Pending outbox rows stay.

## 5. API routes

Everything is under `/api`. JSON in and out. Every route needs the session cookie, except login and `/healthz`.

| method & path | purpose |
|---|---|
| `POST /api/auth/login` `{password}` | sets an httpOnly, Secure, SameSite=Strict cookie. Rate limited to 5 tries per 15 min per IP |
| `POST /api/auth/logout` · `GET /api/auth/me` | |
| `GET /api/accounts?q=` | list with the health colour, counts by colour, last_msg_at |
| `GET /api/accounts/{id}` | detail: status_detail, profile, overrides, recent chats (20) |
| `PATCH /api/accounts/{id}` | `{profile_id?, profile_overrides?, proxy?}` |
| `POST /api/accounts/{id}/power` `{on}` | connect / disconnect |
| `POST /api/accounts/{id}/ai` `{on}` | refused without a profile |
| `DELETE /api/accounts/{id}` `{confirm: username}` | log out + remove |
| `GET /api/accounts/{id}/avatar` | JPEG |
| `POST /api/accounts/{id}/chats/{peer}/reset` | sets ai_state back to `active` |
| `POST /api/imports` (multipart) → `{job_id}` · `GET /api/imports/{job_id}` | session upload |
| `POST /api/phone-login/start` `{phone, profile_id?}` → `{login_id}` | |
| `POST /api/phone-login/{login_id}/code` `{code}` → `{status: done|password_needed}` | |
| `POST /api/phone-login/{login_id}/password` `{password}` · `DELETE /api/phone-login/{login_id}` | |
| `GET/POST /api/profiles` · `PATCH/DELETE /api/profiles/{id}` | personas |
| `GET /api/capital/catalog` | models + presets (cached for 10 min) |
| `GET /api/system/status` | portal: last ok / pending / failed; AI: credit alert, last error; version |
| `POST /api/system/outbox/retry-failed` · `GET /api/system/activity` | |
| `PATCH /api/system/settings` | quiet hours, debounce, AI kill switch |
| `GET /healthz` | `{ok, accounts_online}`, no auth, no details |

**CSRF:** the cookie is SameSite=Strict, and every mutating route requires `Content-Type: application/json` (or multipart for imports) plus an `X-Panel: 1` header.

## 6. Screens (mobile-first)

A floating menu button opens a left drawer with **Accounts**, **Add accounts**, **Personas**, **Status** and **Log out**.

1. **Login:** password field only.
2. **Accounts:**
   - A search bar, a refresh button, and colour chips with counts (All · Active · Quiet · Dead · Off) that double as filters.
   - **Cards:** a coloured left border, the avatar, `@username` and phone, the persona name, and "last message 2m ago". A **power** toggle, a **chat** toggle, and a ⋯ menu with Details and Delete.
   - A red banner across the top when AI credits run out or portal sync is failing.
3. **Account detail** (bottom sheet): the status with its detail, a persona picker plus a few overrides, a proxy field, and recent chats with their AI state and a "reset" action. The delete dialog lives here.
4. **Add accounts**, as two tabs:
   - **Upload sessions:** a drop zone or file picker for many files or a zip. A live result list shows each file as ✅ `@user +phone`, ❌ dead (reason), or ⚠️ duplicate. There's a persona picker to apply to new accounts.
   - **Phone login:** a three-step form (phone → code → 2FA).
5. **Personas:** a list of cards, and an editor with model and preset dropdowns from the catalog plus the override fields grouped (Identity, Style, Media, CTA).
6. **Status:**
   - Portal sync: queue size, failed rows with errors, a "Retry failed" button, and the time of the last successful send.
   - Capitalbot: the credit state and recent errors.
   - Recent activity, and global settings including the AI kill switch.

## 7. Config (`.env`)

The panel password isn't in the env: `python -m panel set-password` stores an argon2 hash in the `settings` table and signs out every session. That avoids `$` quoting problems in env files and needs no restart.

```
PANEL_ENC_KEY=            # Fernet key: python -m panel gen-key
PANEL_SECRET=             # cookie signing
TG_API_ID= TG_API_HASH=   # panel's own app (my.telegram.org), for phone login / sessions without json
CAPITAL_LICENSE_KEY=
PORTAL_INGEST_URL=https://fansflow.eu/api/ingest/convo
PORTAL_INGEST_API_KEY= PORTAL_INGEST_HMAC_SECRET=
DATA_DIR=/var/data            # the Render persistent disk mount
PUBLIC_ORIGIN=https://panel.fansflow.eu
```

## 8. Deploy (Render)

Full click-by-click steps are in `DEPLOY.md`. In short:

- **One Web Service, Starter plan**, built from this repo with Root Directory `telegram-panel`. Build: `pip install -r requirements.txt && npm --prefix frontend ci && npm --prefix frontend run build`. Start: `uvicorn --factory panel.main:create_app --host 0.0.0.0 --port $PORT --workers 1`.
- **Single instance, enforced.** A persistent disk (mounted at `/var/data`, `DATA_DIR=/var/data`) holds the sessions, SQLite and lock file. Render attaches a disk to only one instance and deploys stop-the-old-before-starting-the-new, so the one-connection-per-account rule and the `fcntl` lock hold. Manual scaling, 1 instance, no autoscaling.
- **HTTPS + domain:** Render terminates TLS for `panel.fansflow.eu` (CNAME to the service). No reverse proxy of our own.
- **Secrets** are the service's environment variables; the panel password is set once via the Render Shell (`python -m panel set-password`).
- **Updates:** push to the branch → Render redeploys. **Backups:** enable the disk's scheduled snapshots; `PANEL_ENC_KEY` is kept outside them.

### Repo hygiene (in step 0)
- `telegram-panel/.gitignore`: `.env`, `.venv/`, `data/`, `*.session`, `*.session-journal`, `*.zip`, `*.db`, `*.sqlite*`, `__pycache__/`, `frontend/node_modules/`, `frontend/dist/`.
- **Portal side** (one small commit, needs your OK): today `tsconfig.json` includes `**/*.ts`, `eslint` lints everything, and there's no `.vercelignore`. So add `telegram-panel` to the tsconfig `exclude` list and the eslint `ignores`, and add a `.vercelignore` with `telegram-panel/`. That stops the panel from breaking the portal's Vercel build or being uploaded to Vercel.

## 9. Build order

Ship vertical slices, and test each one on the deployed Render panel with one real account before moving on.

0. ✅ **Skeleton** (2026-10-14): `.gitignore`, the portal excludes, the FastAPI app with lifespan + lock file, SQLite models, crypto, the CLI (`gen-key`, `set-password`), panel login, Vite shell with drawer + login screen, and the deploy runbook (now Render; the original VPS unit/Caddyfile were dropped when we moved to Render). *Done when:* it's deployed and you can log in from a phone.
1. ✅ **Session import + account list** (2026-10-14): session parsing (Telethon + Pyrogram), JSON mapping, the import job, AccountManager (one connection per account, connect/disconnect/log-out, startup reconnect, drop watcher), the Accounts screen with search, refresh, health colours, power + AI toggles, the detail sheet, avatars and delete. Duplicates are caught by the auth-key sha256 before any second connection. *Done:* covered by `tests/test_accounts_api.py` against a fake Telegram; browser-checked. *Not yet:* incoming-message activity (so cards sit amber until step 2 wires the listener).
2. ✅ **Portal sync** (2026-10-16): the Telethon message listener (incoming + outgoing), message/chat storage, convo event derivation (`first` + `reply`), the outbox worker (signed batches, backoff, 413 halving, 401/503 alert), account-status events on every status change, and the Status screen's portal panel (queue counts, failed rows, retry, activity). `tests/test_portal.py` checks the signature against the portal's `signIngestBody` vector; `tests/test_events.py` covers derivation end-to-end on a fake Telegram. **Portal side:** `POST /api/ingest/account-status` (same auth as convo ingest) — **record-only** (§10.1): it stores `panelStatus`/`lastSeenAt` and never changes `TgStatus` or assignments. *Done when:* a real DM to a panel account shows up in the portal's Convos as PENDING, then QUALIFIED or REVIEW after a reply.
3. ✅ **Capitalbot AI** (2026-10-16): the Capitalbot client (`capital.py` — `/generateResponse` + `/getModelsAndPresets`, the retry policy), the AI reply worker (`ai.py` — per-chat debounce, chatHistory builder, response handling for every flag, the already-answered guard, fan-media upload, media send with ffmpeg voice), the catalog/personas/settings/chat-reset routes, and the Personas screen + account persona picker + AI kill switch. Idle until `CAPITAL_LICENSE_KEY` is set. *Done:* `tests/test_capital.py`, `tests/test_ai.py` (full text reply, photo both ways, every flag path, debounce, error classes) and `tests/test_step3_api.py` cover it; browser-check on one account per the runbook below.
4. **Phone login.**
5. **Health loop + polish:** quiet/limited/banned detection, reconnect backoff, activity log, global settings, backups.
6. **Optional:** follow-ups (§10, decision 4) and per-account proxies, if the client wants them.

**Tests that stay green:**
- HMAC matches the portal.
- Event derivation matches the portal's `toConvoEvent` rule.
- Every chatHistory message has an integer timestamp.
- Every Capitalbot flag maps to the right `ai_state`.
- A duplicate import never creates a second client.
- Dead or failed sessions are never logged out.
- The outbox keeps retrying on 5xx, and marks `failed` on `ok:false`.
- Secrets in the DB are never plaintext.

## 10. Decisions

All settled on 2026-10-14. Nothing is waiting on the client or Capitalbot. ✅ marks the client's own calls. The rest are the safest option, chosen by us.

1. ✅ **Account status → portal:** a new portal route `POST /api/ingest/account-status` with the same auth as convo ingest. **Record-only** (settled 2026-10-16): it stores online/offline/limited/banned/revoked in new `panelStatus`/`lastSeenAt` fields and surfaces them in the Director's pool, but never changes `TgStatus` or VA assignments and never notifies — a real ban stays a human action through the existing UI, so an automated beacon can't churn assignments or spam VAs. Built in step 2.
2. ✅ **Portal Pool:** the client adds accounts in the portal by hand, under the same username. If ingest replies `unknown_account`, the panel shows a "not in portal" hint on the card.
3. **Portal CapitalAI cron sync:** left as it is. Panel calls use the numeric Telegram id as `accountId` (§11.1), and that sync matches on username. So it skips panel accounts as "not ours" and can't double-count them. The panel is the only reporter for its accounts. The cron can be switched off later without any code change.
4. **Follow-ups:** off. Only a fan message triggers a reply, so the panel never sends anything unprompted. Turning them on would be a new decision.
5. **Quiet threshold:** 12h with no incoming message.
6. **Backfill on add:** off. Only chats with activity after an account is added get reported.
7. **Proxies:** connect direct from Render's IP. A proxy in an uploaded `.json` is stored encrypted but not used. Imports test sessions one at a time with a 2s gap, to avoid a burst of logins from one IP.
8. **Account count:** built for up to about 200 accounts in one process.
9. ✅ **Sole connection:** the panel is the only Telegram connection. Capitalbot is used through its API only, never through its own Telegram connector.
10. **Panel domain:** `panel.fansflow.eu`.
11. **Unreadable newer-layer updates (settled 2026-10-21):** Telegram periodically sends updates from an API layer newer than our Telethon (1.45.0 is the newest on PyPI; the GitHub `v1` mirror is behind, so there's no version to bump to). A single such update is already skipped by Telethon's receive loop, but one inside a `getDifference` response makes Telethon tear the connection down (`TypeNotFoundError`). We classify that as a **transient** drop and auto-reconnect with backoff (5s→5min, jittered): a fresh `StringSession` connection re-baselines on `getState` and skips the unreadable backlog, so the account comes back on its own — no manual toggling. Banned/revoked (powered off) and **frozen** (left as-is) are not retried. The card shows "Reconnecting to Telegram…", never the raw exception. This realises the step-5 "reconnect backoff" (§4.5), event-driven rather than via the 60s loop.

## 11. Capitalbot questions (resolved)

✅ marks the client's own calls; the rest are the safest reading of `CapitalAI_Docs.md`. Our copy of the docs is the contract: unknown response fields are ignored, and anything unexpected is logged and surfaced on Status.

1. ✅ **`accountId`:** the account's numeric Telegram id, as a string. It never changes, unlike a username.
2. **`platform`:** `"Telegram"`.
3. ✅ **Roles:** fan messages → `user`. Everything the account sent, by the AI or by hand → `assistant`. `bot` is never sent.
4. **Whose history wins:** ours, because it's what actually exists on Telegram. A reply that failed to send isn't in the history.
5. **History length:** the last 50 messages, capped at 200 KB of JSON.
6. ✅ **Re-served pending responses:** a reply is sent only if the chat hasn't been answered since the fan message that triggered the call. Otherwise it's dropped and logged (§4.3 step 8).
7. ✅ **Timeouts:** no automatic retry after a timeout or a `5xx`. It's logged, and the fan's next message triggers a fresh reply. A connection that never opened and a `429` are retried once, because Capitalbot never processed those requests. Timeout is 90s.
8. ✅ **Credits:** not tracked. `aiCreditOver` and every Capitalbot error appear in the panel (a banner, the Status screen and the account card).
9. **Un-convert check:** no timer calls. A converted chat is called again only when the fan writes.
10. **Follow-ups:** off (§10.4), so the question doesn't arise.
11. **`underage` / `timewaste`:** the panel stops calling by itself and doesn't rely on Capitalbot to stay silent. `underage` can't be reset.
12. **`conversationId`:** read from the top level, falling back to `statistics.conversationId`, and treated as optional.
13. **Voice format:** whatever comes back is converted to OGG/Opus with ffmpeg. If that fails it's sent as a plain audio file, and if that also fails it's skipped and logged.
14. ✅ **Fan media:** one file per upload, the newest media in the batch. Everything else goes as markers, each with its own Telegram message time.
15. **Rate limits:** at most 10 Capitalbot calls in flight across the panel, and the per-chat debounce keeps each fan far under 60/min. A `429` is shown on Status.
16. **`messages` / `media` fields:** ignored; only `content` is read.
17. **Docs version:** `CapitalAI_Docs.md` (in this folder) is the version we build against. If Capitalbot changes behaviour, the doc gets updated first.
