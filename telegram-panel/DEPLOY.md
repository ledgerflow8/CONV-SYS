# Deploy — Telegram Panel (Render)

One **Web Service** on the **Starter** plan, pinned to a single instance, with a persistent disk for
`data/` (sessions, SQLite, lock file, avatars). HTTPS and the custom domain are handled by Render — no
Caddy, no systemd.

> **Why single-instance matters.** The panel holds exactly one Telegram connection per account and takes
> an `fcntl` lock on `data/panel.lock` at startup. Two instances would both try to connect the same
> accounts and Telegram would kill the duplicated sessions (`AuthKeyDuplicatedError`). The persistent disk
> is what enforces this: Render can attach a disk to only one instance, so the service **cannot** scale past
> 1, and each deploy **stops the old instance before starting the new one** (no overlap). Never add a second
> instance and never enable autoscaling.

## 0. Before you start
- The code is in the `telegram-panel/` subfolder of the repo, on the `telegram-panel` branch. Render builds
  from GitHub, so that branch must be pushed.
- Generate the two secrets locally (keep them somewhere safe — see step 4):
  ```bash
  cd telegram-panel
  .venv/bin/python -m panel gen-key    # → PANEL_ENC_KEY
  .venv/bin/python -m panel gen-key    # → PANEL_SECRET
  ```
  Keep `PANEL_ENC_KEY` **separate from any backup of the disk**. Without it the stored sessions can't be
  decrypted.
- Have ready: the panel's Telegram app `TG_API_ID`/`TG_API_HASH` (my.telegram.org), and the portal's
  `INGEST_API_KEY` / `INGEST_HMAC_SECRET` (the panel must use the **same** values).

## 1. Create the Web Service
In the Render dashboard:
1. **New +** (top right) → **Web Service**.
2. **Connect** the GitHub repo. If Render hasn't seen it, click **Configure account**, grant access to the
   repo, then pick it.
3. On the configuration screen set:
   - **Name:** `tgpanel` (this becomes `tgpanel.onrender.com`).
   - **Region:** `Frankfurt (EU Central)` (close to the client / `fansflow.eu`).
   - **Branch:** `telegram-panel`.
   - **Root Directory:** `telegram-panel`  ← important: build/start run inside this subfolder.
   - **Runtime / Language:** `Python 3`.
   - **Instance Type:** `Starter`.
   - **Build Command:**
     ```
     pip install -r requirements.txt && npm --prefix frontend ci && npm --prefix frontend run build
     ```
   - **Start Command:**
     ```
     uvicorn --factory panel.main:create_app --host 0.0.0.0 --port $PORT --workers 1
     ```
4. **Do not** click Create yet — expand **Advanced** and do steps 2–4 first (they're on the same screen).

## 2. Pin the instance count (no autoscaling)
Under **Advanced → Scaling** (or the **Scaling** tab after creation):
- **Scaling:** `Manual`.
- **Number of instances:** `1`.
- Leave **Autoscaling** **off**. Adding the disk in step 3 also blocks scaling, but set this explicitly.

## 3. Add the persistent disk
Under **Advanced → Disks → Add Disk**:
- **Name:** `tgpanel-data`
- **Mount Path:** `/var/data`
- **Size:** `5 GB` (1 GB filled up on 2026-10-25; Status → Data disk shows usage and warns at 80 %).

This disk is where `panel.db`, `panel.lock` and avatars live, via `DATA_DIR` in the next step.

## 4. Environment variables
Under **Advanced → Environment Variables** (or the **Environment** tab), **Add** each of these. Mark the keys,
hashes and secrets as **secret** (click the eye/lock) so they're hidden in the dashboard:

| Key | Value | Notes |
| --- | --- | --- |
| `PANEL_ENC_KEY` | (from step 0) | secret; decrypts sessions/2FA/proxies. Comma-separate to rotate. |
| `PANEL_SECRET` | (from step 0) | secret; signs the login cookie. |
| `DATA_DIR` | `/var/data` | must equal the disk mount path. |
| `PUBLIC_ORIGIN` | `https://panel.fansflow.eu` | `https://` turns on Secure cookies. |
| `TG_API_ID` | *(my.telegram.org)* | for phone login and sessions with no `.json`. |
| `TG_API_HASH` | *(my.telegram.org)* | secret. |
| `PORTAL_INGEST_URL` | `https://fansflow.eu/api/ingest/convo` | |
| `PORTAL_INGEST_API_KEY` | *(portal's `INGEST_API_KEY`)* | secret; used from step 2. |
| `PORTAL_INGEST_HMAC_SECRET` | *(portal's `INGEST_HMAC_SECRET`)* | secret; used from step 2. |
| `CAPITAL_LICENSE_KEY` | *(Capitalbot)* | secret; used from step 3. |
| `PYTHON_VERSION` | `3.12.7` | pins the build toolchain. |
| `NODE_VERSION` | `22` | so the frontend build (Vite 8) has Node ≥ 20. |

Then click **Create Web Service**. The first build runs the build command (pip + `npm run build` → `frontend/dist`)
and the start command boots uvicorn. Watch **Logs**; you want a clean startup with no `AlreadyRunning`.

## 5. Health check
**Settings → Health & Alerts → Health Check Path:** `/healthz` → **Save**. (It's exempt from login and returns
`{"ok": true, "accounts_online": N}`.)

## 6. Set the panel password
The service is up but has no password yet. Open the service's **Shell** tab (available on Starter) and run:
```bash
python -m panel set-password
```
It writes to `panel.db` on the mounted disk and signs out any existing login. (To change it later, run the
same command; no redeploy needed.)

## 7. Custom domain `panel.fansflow.eu`
1. **Settings → Custom Domains → Add Custom Domain** → enter `panel.fansflow.eu` → **Save**. Render shows a
   **CNAME target** like `tgpanel.onrender.com`.
2. At the DNS provider for `fansflow.eu`, add:
   - Type `CNAME`, Host/Name `panel`, Value `tgpanel.onrender.com` (the exact target Render showed), TTL auto.
   - `fansflow.eu` itself stays on its current host (the portal); this only adds the `panel` subdomain.
3. Back in Render, click **Verify**. Render issues the TLS certificate automatically once DNS resolves
   (usually minutes).
4. Check: open `https://panel.fansflow.eu/healthz`, then log in from a phone.

## Updates
Push to the `telegram-panel` branch → Render auto-deploys (stop-old-then-start-new, so the lock never clashes).
Or **Manual Deploy → Deploy latest commit** in the dashboard. Env-var or settings changes also trigger a redeploy.

## Disk checks
- What fills the disk (read-only, in the **Shell** tab): `python -m panel disk`
- Recover convos that failed to save (e.g. after the disk filled): Status → **Recover missed convos**, or in the
  Shell `python -m panel recover --since 2026-10-25T15:30:00Z` (dry run), then add `--apply`. It asks the running
  panel to do the work over its own Telegram connections.

## Backups
**Settings → Disks → tgpanel-data** offers scheduled disk snapshots — enable them. A snapshot holds the
encrypted sessions and SQLite; store `PANEL_ENC_KEY` **outside** the snapshot or a leaked backup is useless to
you too, but a lost key makes every session unrecoverable.

## Notes / later
- **Logs:** the **Logs** tab (equivalent to the old `journalctl -u tgpanel -f`).
- **ffmpeg:** step 3's media handling may need `ffmpeg`, which isn't in Render's native Python image. When that
  lands, either `apt`-install it in the build command or switch this service to a Dockerfile. Not needed yet.
- **Time sync:** Render hosts are NTP-synced, so the portal's ±5-min signature window is satisfied without action.
