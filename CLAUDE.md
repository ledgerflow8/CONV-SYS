# CLAUDE.md

Read `docs/PLAN.md` before doing anything. It is the source of truth for scope, schema, flows, and build order.

## Project
Role-based VA management portal (Director → Lead Manager → Lead VA → VA). VAs promote a model's Telegram account; qualified conversations earn per-convo commission up the chain; weekly stablecoin payouts.

## Deadline
Launch in 2 days. Follow the build order in `docs/PLAN.md` §8. Ship working vertical slices; don't gold-plate.

## Stack
Next.js 15 App Router + TypeScript, Tailwind + shadcn/ui, Prisma + Supabase Postgres, grammY bot via webhook, Vitest. Deploy on Vercel.

## Rules
- Money is integer cents. Never floats.
- Every data read goes through `scopeFor(user)`. Never hand-scope in a page.
- All convo data enters through `ingestConvoEvent()` only. No other code writes convo status.
- Rates are snapshotted onto each convo when it qualifies.
- Locked weeks never change.
- Multi-step writes (Add VA, ban/reassign, week lock) run in one transaction.
- Generated passwords: store hashed; plaintext only encrypted until the bot delivers it, then wipe.
- No private keys on the server. Payouts are exported and marked paid manually.
- No branding from the reference product. Use neutral names until the client gives theirs.
- Mobile-first UI: cards, floating menu button, left drawer, as described in the plan.
- Keep the invariant tests in `docs/PLAN.md` §4 green.

## Open decisions
See `docs/PLAN.md` §9. Use the listed defaults; don't block on them.
