# VA Management Portal — Build Plan

Target: launch-ready in **2 days**. This document is the source of truth for the build. If code and this doc disagree, fix one of them on purpose.

---

## 1. What we're building

A role-based portal for an agency that runs promotion teams. VAs promote a model's Telegram account; when a qualified conversation lands on that account, the VA and everyone above them earn commission. Payouts are weekly, in stablecoin, to each person's wallet.

### Roles and hierarchy

```
Director (1)
 └── Lead Manager (many)
      └── Lead VA (many per LM) — each team is assigned ONE model
           └── VA (many per Lead VA) — each VA is assigned ONE Telegram account at a time
```

| Role | Creates | Sees |
|---|---|---|
| Director | Lead Managers, models, Telegram accounts, resources, settings | Entire org, live |
| Lead Manager | Lead VAs (and assigns their model) | All teams under their Lead VAs |
| Lead VA | VAs (via invite link), can fire VAs | Their own team |
| VA | — | Their own accounts, earnings, resources |

### Pay

| Who | Rate | Basis |
|---|---|---|
| VA | $0.25 | per qualified convo on their assigned account |
| Lead VA | $0.10 | per qualified convo from anyone on their team |
| Lead Manager | **TBD** (setting, default 0) | per qualified convo across their teams |

Rates live in settings and are **snapshotted onto each convo** when it qualifies, so changing a rate never rewrites past earnings.

### Pay week

Monday 00:00 → Sunday 23:59:59 in the org timezone (default `Etc/GMT-2`, shown as "GMT +2"). The week **locks at Monday midnight**, payouts are generated for the locked week, and the Director marks them paid.

---

## 2. Stack

| Layer | Choice | Why |
|---|---|---|
| App | **Next.js 15 (App Router) + TypeScript** | One codebase for UI, API, bot webhook, redirects |
| UI | Tailwind + shadcn/ui | Fast, matches the clean card look in the references |
| DB | **Postgres on Supabase** | Managed, has Storage for media + Realtime if we want it |
| ORM | Prisma | Clear schema, migrations, transactions |
| Auth | Username + password (bcrypt), session in httpOnly signed cookie (`jose`) | No email, no signup — accounts are created top-down |
| Bot | **grammY**, webhook at `/api/telegram/webhook` | Simple, typed |
| Phone → country | `libphonenumber-js` | Country from a phone prefix |
| Live numbers | Server pages re-rendered every 15s while visible (`router.refresh`, `LiveRefresh`) | Same effect as SWR polling, no extra JSON endpoints; all reads stay server-side and scoped |
| Cron | Vercel Cron → `/api/cron/lock-weeks`, daily 22:05 UTC (= Monday 00:05 GMT+2) | Locks every finished week, so a missed run or timezone change catches up; daily fits the Vercel Hobby limit |
| Hosting | Vercel (or Netlify) | Geo header for tracking-link country |
| Tests | Vitest | Qualification + rollup invariants |

Money is stored as **integer cents** everywhere. Never floats.

---

## 3. Data model (Prisma outline)

```prisma
enum Role        { DIRECTOR LEAD_MANAGER LEAD_VA VA }
enum UserStatus  { ACTIVE FIRED DISABLED }
enum TgStatus    { AVAILABLE ASSIGNED BANNED RETIRED }
enum ConvoStatus { PENDING QUALIFIED REJECTED REVIEW }
enum CountrySrc  { PHONE CLICK MANUAL UNKNOWN }
enum WeekStatus  { OPEN LOCKED PAID }
enum PayStatus   { PENDING SENT FAILED }

model User {
  id             String   @id @default(cuid())
  username       String   @unique          // portal login, e.g. didi_nimi_LVA
  passwordHash   String
  role           Role
  status         UserStatus @default(ACTIVE)
  parentId       String?                    // VA→LeadVA, LeadVA→LM, LM→Director
  parent         User?    @relation("tree", fields: [parentId], references: [id])
  children       User[]   @relation("tree")
  modelId        String?                    // set on LEAD_VA (team model); VAs inherit
  telegramHandle String?                    // the person's own TG @handle
  telegramUserId BigInt?  @unique           // bound when they /start the bot
  walletAddress  String?                    // Aptos: 0x + 64 hex (was EVM 0x + 40 until 2026-10-29), one per user
  createdById    String?
  createdAt      DateTime @default(now())
  firedAt        DateTime?
}

model Model {                               // the creator, e.g. "Sophie"
  id       String @id @default(cuid())
  name     String @unique
  active   Boolean @default(true)
}

model TgAccount {                           // purchased Telegram accounts (the pool)
  id         String   @id @default(cuid())
  modelId    String
  username   String   @unique              // sophiejetlag
  phone      String                         // +1309...
  link       String                         // https://t.me/sophiejetlag
  status     TgStatus @default(AVAILABLE)
  vaId       String?  @unique               // current holder (null if not assigned)
  sessionRef String?                        // later: encrypted session for reply detection
  notes      String?
  createdAt  DateTime @default(now())
}

model TgAssignment {                        // history — who held which account, when
  id          String   @id @default(cuid())
  tgAccountId String
  vaId        String
  startedAt   DateTime @default(now())
  endedAt     DateTime?
  endReason   String?                       // fired | banned | reassigned
}

model TrackingLink {                        // one per VA, survives reassignment
  id     String @id @default(cuid())
  slug   String @unique                     // /v/k3j9x2
  vaId   String @unique
  active Boolean @default(true)
}

model LinkClick {
  id          String   @id @default(cuid())
  linkId      String
  vaId        String
  tgAccountId String?                       // account the click was redirected to
  country     String?                       // ISO-2 from geo header
  referrer    String?
  refDomain   String?
  blocked     Boolean  @default(false)      // blocked source
  ipHash      String?                       // salted hash, never raw IP
  userAgent   String?
  createdAt   DateTime @default(now())
}

model Convo {
  id            String      @id @default(cuid())
  accountRef    String                      // account username (lowercase); dedupe key even before the account is in the pool
  tgAccountId   String?                     // null while REVIEW: unknown_account
  peerId        String                      // the person on the other end (TG user id)
  peerPhone     String?
  // attribution, snapshotted at qualification time
  vaId          String?
  leadVaId      String?
  leadManagerId String?
  modelId       String?
  weekId        String?
  // qualification
  country       String?
  countrySource CountrySrc  @default(UNKNOWN)
  clickId       String?
  source        String?                     // ref domain if known
  firstMsgAt    DateTime
  repliedAt     DateTime?
  status        ConvoStatus @default(PENDING)
  rejectReason  String?                     // non_tier1 | blocked_source | review_rejected
  reviewReason  String?                     // unknown_account | unattributed | unknown_country
  qualifiedAt   DateTime?
  // rates snapshot (cents)
  vaCents       Int @default(0)
  leadVaCents   Int @default(0)
  lmCents       Int @default(0)
  createdAt     DateTime @default(now())

  @@unique([accountRef, peerId])            // one person counts once per account
  @@index([vaId, weekId, status])
  @@index([leadVaId, weekId, status])
  @@index([leadManagerId, weekId, status])
}

model Week {
  id       String     @id @default(cuid())
  startsAt DateTime   @unique
  endsAt   DateTime
  status   WeekStatus @default(OPEN)
}

model Payout {
  id            String    @id @default(cuid())
  userId        String
  weekId        String
  role          Role
  convos        Int
  amountCents   Int
  walletAddress String?                     // snapshot at lock time
  status        PayStatus @default(PENDING)
  txHash        String?
  paidAt        DateTime?
  @@unique([userId, weekId])
}

model InviteToken {                         // one-time bot deep link
  id        String   @id @default(cuid())
  tokenHash String   @unique
  userId    String
  expiresAt DateTime
  usedAt    DateTime?
}

model Resource {                            // SOPs, links, media pool
  id        String  @id @default(cuid())
  modelId   String?                         // null = all models
  section   String                          // SOP | TG_MEDIA | CREATOR_TEMPLATE | MEDIA_POOL
  category  String?                         // PFPs, Post Pictures, ...
  title     String
  url       String?                         // SOP link
  filePath  String?                         // Supabase Storage path
  sort      Int     @default(0)
  createdAt DateTime @default(now())
}

model Setting { key String @id  value Json }
// keys: rates {va, leadVa, lm} in cents, tier1Countries [ISO-2],
// blockedDomains [..], timezone, payoutCurrency, clickMatchWindowMin,
// supportTelegram (handle the drawer's "Report a Problem" opens; empty = disabled)

model AuditLog {
  id       String   @id @default(cuid())
  actorId  String?
  action   String
  target   String?
  meta     Json?
  createdAt DateTime @default(now())
}
```

### Scoping rule (applies to every query)

One helper, `scopeFor(user)`, returns the filter for what that user may see:

- Director → everything
- Lead Manager → `leadManagerId = me`
- Lead VA → `leadVaId = me`
- VA → `vaId = me`

Every dashboard query goes through it. No exceptions, no hand-written scoping in pages.

---

## 4. The convo pipeline (the core)

All convo data, whatever its origin, enters through **one function**: `ingestConvoEvent(event)`.

```ts
type ConvoEvent = {
  tgAccount: string        // account username or id
  peerId: string           // Telegram user id of the person
  peerPhone?: string       // if visible
  firstMsgAt: string       // ISO
  repliedAt?: string       // ISO, when the model's account replied
  source?: string          // optional, if the source system knows it
}
```

Entry points that call it:

1. `POST /api/ingest/convo` — authenticated with an API key + HMAC signature. This is where the client's AI API will post once we have its details.
   Headers: `Authorization: Bearer <INGEST_API_KEY>`, `X-Timestamp: <unix seconds>` (±5 min), `X-Signature: sha256=<hex HMAC-SHA256(INGEST_HMAC_SECRET, "<timestamp>.<raw body>")>`. Body: one event or `{ "events": [...] }` (≤ 500). Times must be ISO 8601 with a timezone.
2. **Director → Import convos** (CSV upload) — the launch-week path until the API is connected.
3. Later: a Telegram session listener, if we connect accounts directly.

### Steps inside `ingestConvoEvent`

1. **Find the account.** Unknown account → store as `REVIEW`, reason `unknown_account`.
2. **Attribute.** Look up `TgAssignment` active at `firstMsgAt` → VA. From the VA, walk up to Lead VA and Lead Manager. Snapshot all IDs.
3. **Upsert** on `(tgAccountId, peerId)`. A repeat event updates the same row (e.g. the reply arrives later). It never creates a second convo.
4. **Country.**
   - `peerPhone` present → country from prefix, `countrySource = PHONE`.
   - else → most recent `LinkClick` for this VA's link that redirected to this account within `clickMatchWindowMin` (default 30) before `firstMsgAt` → its country, `countrySource = CLICK`.
   - else → `UNKNOWN`.
5. **Source.** If matched click is `blocked` → reject `blocked_source`.
6. **Decide.**
   - country known and not Tier 1 → `REJECTED`, `non_tier1`
   - blocked source → `REJECTED`, `blocked_source`
   - no `repliedAt` yet → `PENDING` (qualifies automatically when the reply event arrives)
   - country `UNKNOWN` → `REVIEW` (Director approves or rejects in the review queue)
   - otherwise → `QUALIFIED`, set `qualifiedAt`, `weekId` (week containing `repliedAt`), snapshot rates.
7. **Audit log** every status change.

All of this runs in a single DB transaction.

### Invariants (enforced by tests)

- Sum of VA earnings in a team = team total on the Lead VA dashboard.
- Sum of team totals under a Lead Manager = Lead Manager total.
- Sum over all Lead Managers = Director total.
- A convo counts in exactly one week and exactly once.
- A locked week never changes. Late events for a locked week go to the current open week and are flagged `late` in the audit log.

---

## 5. Telegram account pool + VA onboarding

### Adding accounts (Director)

**Telegram Pool** page: add one account (model, username, phone, link) or bulk paste/CSV. Duplicates rejected by username. Pool shows counts per model: available / assigned / banned.

### Add VA (Lead VA)

1. Lead VA enters the VA's Telegram @handle.
2. In one transaction:
   - create the VA user (username = `handle` + suffix rules, generated password),
   - pick the next `AVAILABLE` account for the team's model using `SELECT … FOR UPDATE SKIP LOCKED`, mark `ASSIGNED`, write `TgAssignment`,
   - create the VA's `TrackingLink`,
   - create a one-time `InviteToken` (expires in 72h).
3. Lead VA sees: **"Send this to your VA: `t.me/<Bot>?start=<token>`"** with a copy button.
4. If the pool for that model is empty, **Add VA is disabled** with the warning "No Telegram accounts left for this model. Ask your Director to add more."

### Bot (grammY)

- `/start <token>` → validate token (unused, not expired) → bind `telegramUserId` → mark token used → send the welcome:

```
✅ You've been authorised!

👤 Username: <username>
🔑 Password: <password>
📱 Assigned model: <model>
   TG username: @<account>
   Phone: <phone>
   Link: <t.me link>
🔗 Your tracking link: <domain>/v/<slug>

Log in at: <dashboard url>
⚠️ Don't share your login with anyone, not even your Lead VA.
```

- Password is generated at creation and **only delivered via the bot** (stored hashed; plaintext held encrypted only until the token is used, then wiped).
- Invalid or used token → "This link has expired. Ask your Lead VA for a new one."
- Lead VA can regenerate an invite (issues a new password too).

### Ban / reassign

Director (or Lead VA, if allowed) marks an account `BANNED` → current assignment ends → next available account assigned to that VA → bot DMs the VA the new account details. Their tracking link now redirects to the new account automatically.

### Fire VA

Lead VA fires a VA → user `FIRED`, login blocked, tracking link deactivated, assignment ended, account returns to `AVAILABLE`. Earned convos in the open week still pay out.

### Org changes (client feedback 2026-10-18, `src/lib/org.ts`)

- **Who fires whom:** Director → anyone; Lead Manager → their Lead VAs; Lead VA → their VAs. Firing someone with people under them requires a choice: fire them too, or move them to another person of the same role (a Lead VA's VAs moving to a team on another model swap accounts, as below).
- **Fire inactive VAs:** Director (all) or Lead VA (own team) picks N days; VAs with no qualified convo in N days, hired or re-hired more than N days ago, are listed, then fired on confirm.
- **Move a team to another model** (Director, or the Lead Manager for their own teams; bulk "move all teams" for the Director): preview first. Each VA's account goes back to the old model's pool and they get a free account from the new pool; if short, nothing moves unless confirmed, and VAs left without an account are flagged "Needs account". Bot notifies each VA; tracking links and past earnings unchanged.
- **Needs account:** whenever accounts become free for a model (added, imported, model assigned, restored, freed by firing/moving, or a panel account gets its username), they go to that model's waiting VAs, longest-waiting first, with a bot message.
- **Inactive models** can't be chosen for new teams, team moves, or assigning pool accounts, and their teams can't add VAs.
- **Rename model:** Director, inline on Models; everything references the model by id.
- **Re-adding fired people:** creating a Lead Manager / Lead VA (or adding a VA) whose handle belongs to someone fired reactivates the same login under the new manager.

---

### Weekly leaderboards (client feedback 2026-10-23, `src/lib/leaderboard*.ts`)

- **Boards:** VAs ranked agency-wide by their qualified convos in the open week; Lead VAs by their team's qualified convos. Same counts and snapshotted cents as payouts (`vaId` / `leadVaId`). Ties: whoever reached the count first (latest `qualifiedAt`) ranks higher. Only ACTIVE users are listed. Deliberately agency-wide (not `scopeFor`): only username, convo count and earnings are exposed.
- **Where:** VA board on VA + Director dashboards; Lead VA board on Lead VA, Lead Manager + Director dashboards. Top 10 plus the viewer's own row and their gap to the place above; a Lead Manager's own Lead VAs are highlighted; the Director sees full boards and past winners. Refreshes with the dashboard's live polling.
- **Prizes:** Settings `leaderboardPrizes` (cents; defaults VA $10/$8/$5, Lead VA $30/$10/$5). At week lock, each board's top 3 (with ≥ 1 convo, still ACTIVE) are frozen as `LeaderboardWin` rows and the prize is added to their payout as `Payout.bonusCents` (included in `amountCents`, shown as a separate line in payout history and the CSV). Once per week: the lock is idempotent and `(weekId, board, rank)` is unique.
- **Minimums (client feedback 2026-10-25):** Settings `leaderboardMinConvos` per board and place (defaults: VA 200/200/200; Lead VA 500/0/0 team convos). A place whose holder is below its minimum isn't paid (no passing down), unless `leaderboardPassDown` is on: then each place goes to the best-ranked person not already holding a prize who meets it. `LeaderboardWin.rank` is the prize place. Boards show "Min. N convos" per prize, the viewer's "N more convos to qualify", and badges only on qualifiers. Same rule (`rankBoard`) for the live boards and the lock.

## 6. Tracking links

`GET /v/[slug]`:

1. Look up link → VA → VA's current account.
2. Record `LinkClick`: country from host geo header (`x-vercel-ip-country` on Vercel / `x-nf-geo` on Netlify), referrer + domain, salted IP hash, UA. `blocked = refDomain in blockedDomains`.
3. `302` to the account's `t.me` link.

Inactive link → simple "link unavailable" page.

---

## 7. Screens

Shared shell (from the references): top bar with page title + emoji, date + "Welcome back", timezone pill, avatar initial; floating round menu button bottom-right opening a left drawer; "Report a Problem" and red "Log Out" at the drawer bottom. Mobile-first, max-width container on desktop.

### Login
Gradient background, centred card, logo, username, password, Log In. No signup, no reset. Redirects by role.

### VA — `/va`
- **My Accounts:** red "Payout address missing" banner until wallet set; This week's earnings (qualified × $0.25), qualified this week, active Telegrams, "Pays out Monday"; My Telegram accounts (handle, link, phone, qualified count); How you get paid (rate, week, pay day, Lead VA, wallet input); Payout history.
- **Resources:** handle + number with copy; collapsible sections: Tutorials & SOPs, VA-specific links (their tracking link), TG-specific links, TG media, creator templates, media pool by category with download buttons.

### Lead VA — `/lead-va`
- **Dashboard:** wallet banner; team model badge; Add VA, Assign to existing VA; Team conversations (unpaid this week), Your commission (team × $0.10), My VAs, Telegrams available for the model; My Team list (each VA: account, qualified this week, fire button); Telegram pool status.
- **Payouts:** current commission (not paid yet), wallet input, paid to date, total convos, weekly average + best week, commission history, How you earn.

### Lead Manager — `/lead-manager`
- **Dashboard:** Create Lead VA button; Lead VAs (+ VAs underneath), Unpaid conversations (all teams this week), Owed to VAs, Payout total (VA + Lead commission); Your Lead VAs list, expandable to each team's VAs and their accounts.
- **Create Lead VA modal:** TG username with live validation (min 5 chars, preview `@name_LVA`), model select, "What happens next" box → success modal with username/password/model + copy buttons, no-reset warning, Done disabled until "I've saved the password" is ticked.
- **Payouts:** own commission view (once rate confirmed).

### Director — `/director`
- **Overview:** org totals live — qualified today / this week, owed this week by role, active VAs, pool health per model, convos in review; per-Lead-Manager breakdown with drill-down.
- **People:** Lead Managers (create, disable, regenerate password), searchable directory of everyone.
- **Models:** add / deactivate.
- **Telegram Pool:** add, bulk import, statuses, ban, reassign, history.
- **Convos:** search + filters; **Review queue** (approve / reject UNKNOWN-country convos); **Import CSV**.
- **Payouts:** weeks list; lock week (also automatic via cron); per-week payout table (user, role, convos, amount, wallet) with **Export CSV**; mark paid with tx hash. Missing-wallet users flagged.
- **Resources:** manage SOPs, links, media uploads per model and category.
- **Settings:** rates, Tier 1 country list, blocked source domains, timezone, payout currency, click-match window.

Payout sending is **manual for launch** (export → send from the agency's wallet → paste tx hashes). No private keys on the server.

**Aptos (2026-10-29).** Payouts moved to the Aptos network (`src/lib/wallet.ts`): addresses are 0x + 64 hex; short forms are left-padded and stored lowercase; a 40-hex EVM address and the reserved 0x0–0xf are refused. An address saved before the move counts as missing (banner, lock snapshot, "Use current wallet", "Mark paid" all check `isAptosAddress`). Director → Payouts → **Clear all wallet addresses** (two-step) wipes every user's wallet and the wallet on unpaid payout lines in one transaction; paid lines keep theirs; the audit (`wallet.clear_all`) keeps every old address. The token is the Settings "Payout currency" label; CSV has `wallet_aptos` + `network` columns.

**Approving pending convos after an outage (2026-10-29).** `approvePendingConvos` (in `ingest.ts`, next to review approval): Director selects PENDING convos on Convos → Pending (date-range filter in org time) and confirms; each becomes QUALIFIED without a reply, at today's rates, in its own week if open, else the current open week (audited `convo.late`). Still required: a VA held the account; a known country is Tier 1 (unknown → MANUAL, as in review). One transaction per convo; re-running skips what's done; a later reply never changes it (final).

---

## 8. Build order (2 days)

### Day 1

| Block | Deliverable |
|---|---|
| 1 | Repo setup: Next.js, Tailwind, shadcn, Prisma, Supabase, env, lint. Schema + migration + seed (1 Director, 2 LMs, 4 Lead VAs, 12 VAs, 2 models, 30 TG accounts). |
| 2 | Auth: login, sessions, role redirect, route guards, `scopeFor`. App shell (top bar, drawer, FAB). |
| 3 | Director: Models, Telegram Pool (add + bulk), People (create LM). Lead Manager: Create Lead VA flow + modals. |
| 4 | Lead VA: Add VA transaction (assignment + tracking link + invite), Fire VA, empty-pool state. Bot: `/start` token flow + welcome message. |
| 5 | Tracking links: `/v/[slug]`, click logging, geo, blocked domains. |

### Day 2

| Block | Deliverable |
|---|---|
| 6 | `ingestConvoEvent` + `/api/ingest/convo` + CSV import + review queue. Vitest for qualification + invariants. |
| 7 | Stats layer (one query module, all scoped) → all four dashboards wired with live polling. |
| 8 | Weeks + cron lock + payouts + wallet modal (0x + 40 hex validation; Aptos 0x + 64 since 2026-10-29) + payout pages + CSV export. |
| 9 | VA Resources page + Director resource manager + Supabase Storage uploads. |
| 10 | Ban/reassign flow + bot notification. Polish to match references. Deploy, set bot webhook, smoke-test every role end to end. |

### Launch checklist

- [ ] Real Director account created, seed data removed
- [ ] Bot token + webhook set, `/start` tested with a real invite
- [ ] Tier 1 list and blocked domains reviewed by client
- [ ] Rates confirmed; Lead Manager rate set (or 0)
- [ ] Timezone confirmed
- [ ] Telegram accounts imported into pool
- [ ] Ingest API key generated and stored for the client
- [ ] Invariant tests green

---

## 9. Open decisions (defaults in use until confirmed)

| Question | Default |
|---|---|
| Payout currency: USDT or USDC, which chain | Setting; label only, sending is manual |
| Lead Manager rate | $0.00 setting |
| Client's AI API — format, auth, whether it reports replies/phone | **Decided:** CapitalAI (capitalbot.ai). It doesn't push, so `/api/cron/sync-capitalai` pulls `POST /api/dashboard/search` + `/api/conversation` every 5 min (cron-job.org) and feeds `ingestConvoEvent`. Only conversations whose `accountId` matches a pool username are used. `firstMsgAt` = fan's first message, `repliedAt` = account's first message after it. No phone from CapitalAI → country from tracking-link clicks. Licence key: `CAPITALAI_LICENSE_KEY` |
| Does one person count once per account ever, or once per week? | Once per account, ever |
| Unknown-country convos | Go to Director review queue |
| Does an unknown/no-click source count? | Yes, unless referrer is on the blocked list |
| Can Lead VAs mark accounts banned, or only Director? | Director only |
| Timezone for weeks | GMT+2 |
| Tier 1 countries | **Decided (client):** US, CA, GB, AU, NZ, IE, GG, JE, IM, DE, NO, FI, FR + editable list |
| Password reset | None for users; creator/Director can regenerate. Regenerating ends all of that user's existing sessions (`User.sessionVersion`) |
| Portal username suffixes | `<handle>_LM`, `<handle>_LVA`, `<handle>_VA` (plan only specified `_LVA`) |
| "Report a Problem" destination | **Decided:** opens a Telegram chat with a support handle (`supportTelegram` setting). Handle TBD; item disabled until set |

---

## 10. Env vars

```
DATABASE_URL=
DIRECT_URL=
SUPABASE_URL=
SUPABASE_SERVICE_ROLE_KEY=
SESSION_SECRET=
ENCRYPTION_KEY=            # for temp plaintext passwords
TELEGRAM_BOT_TOKEN=
TELEGRAM_BOT_USERNAME=
TELEGRAM_WEBHOOK_SECRET=
INGEST_API_KEY=
INGEST_HMAC_SECRET=
APP_URL=
IP_HASH_SALT=
CRON_SECRET=
```
