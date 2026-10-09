# Deploying the VA Portal

Production = **Vercel** (site, API, cron) + **Supabase** (Postgres + Storage). Never run the seed against production.

## 1. Database (Supabase Postgres)

Supabase → Project Settings → Database → Connection string:

| Env var | Use | Value |
|---|---|---|
| `DATABASE_URL` | the running site | **Transaction pooler**, port 6543, with `?pgbouncer=true&connection_limit=1` appended |
| `DIRECT_URL` | migrations | **Direct connection** (or Session pooler), port 5432 |

Apply the schema (from your machine, once per release):

```bash
DATABASE_URL="<direct url>" DIRECT_URL="<direct url>" npx prisma migrate deploy
```

## 2. Storage

Already set up (`npm run storage:setup`). The `resources` bucket is private; nothing else to do.

## 3. Vercel

1. vercel.com → Add New → Project → import the GitHub repo. Production branch: `main`.
2. Environment variables (Production):

| Variable | Value |
|---|---|
| `DATABASE_URL`, `DIRECT_URL` | from step 1 |
| `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` | same as `.env` |
| `SESSION_SECRET`, `ENCRYPTION_KEY`, `IP_HASH_SALT`, `CRON_SECRET` | **new** values: `openssl rand -base64 32` each (don't reuse local ones) |
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_BOT_USERNAME` | from BotFather |
| `TELEGRAM_WEBHOOK_SECRET` | new: `openssl rand -hex 32` |
| `INGEST_API_KEY`, `INGEST_HMAC_SECRET` | new: `openssl rand -hex 32` each; give these to the client's developer privately |
| `APP_URL` | `https://<your-domain>` (no trailing slash) |

3. Deploy. The cron in `vercel.json` (daily 22:05 UTC = Monday 00:05 GMT+2) is picked up automatically.

## 4. First Director

From your own terminal (the password is printed once, only to you):

```bash
DATABASE_URL="<direct url>" npx tsx scripts/create-director.ts <username>
```

## 5. Telegram webhook

```bash
TELEGRAM_BOT_TOKEN=... TELEGRAM_WEBHOOK_SECRET=<same as Vercel> APP_URL=https://<your-domain> npx tsx scripts/set-telegram-webhook.ts
```

## 6. CapitalAI sync (cron-job.org)

CapitalAI (the AI on the Telegram accounts) doesn't send us events; we pull every 5 minutes.

1. Vercel env: `CAPITALAI_LICENSE_KEY` = the client's licence key (must be an **active** licence).
2. cron-job.org → Create cronjob:
   - URL: `https://<your-domain>/api/cron/sync-capitalai`
   - Schedule: every 5 minutes
   - Request method: GET
   - Advanced → Headers: `Authorization` = `Bearer <CRON_SECRET from Vercel>`
   - Timeout: 60 s
3. Check: Director → Convos → **CapitalAI sync** shows the last run (and any error, e.g. an expired licence). **Sync now** runs it on demand.

The Telegram usernames in the Pool must match the `accountId` CapitalAI uses for each account (case and a leading @ are ignored). Conversations on other accounts are skipped.

## 7. Smoke test (every role)

- [ ] Director logs in; Settings shows GMT +2 and the rates; set the support Telegram handle
- [ ] Director adds a model, imports Telegram accounts, creates a Lead Manager
- [ ] Lead Manager logs in, creates a Lead VA
- [ ] Lead VA logs in, sets wallet, adds a VA, copies the invite link
- [ ] VA opens the invite in Telegram, gets the welcome message, logs in, sees account + tracking link
- [ ] Open the tracking link on a phone: lands on the Telegram account; Director → Convos is unchanged (no convo yet)
- [ ] POST a signed test event to `/api/ingest/convo`; it appears in Convos and on every dashboard
- [ ] Director bans the VA's account: VA gets the bot message with the new account
- [ ] Director → Payouts → Lock (after a week ends) → Export CSV

## Launch checklist (PLAN.md §8)

- [ ] CapitalAI licence active; cron-job.org job created; Convos page shows a successful sync

- [ ] Real Director account created; seed data never touched production
- [ ] Bot token + webhook set, `/start` tested with a real invite
- [x] Tier 1 list confirmed by client (incl. GG, JE, IM, DE, NO, FI, FR); [ ] blocked domains reviewed by client
- [ ] Rates confirmed; Lead Manager rate set (or 0)
- [ ] Timezone confirmed
- [ ] Telegram accounts imported into pool
- [ ] Ingest API key generated and given to the client
- [ ] Invariant tests green (`npm test && npm run test:db`)
