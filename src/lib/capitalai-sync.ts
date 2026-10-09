// Pull sync: CapitalAI conversations → ingestConvoEvent(). Called every few minutes by cron-job.org
// (/api/cron/sync-capitalai) and by the Director's "Sync now". Safe to run repeatedly:
// ingest is idempotent per (account, fan) and decided convos never change.
import type { ConvoStatus } from "@prisma/client";
import { db } from "@/lib/db";
import { capitalAI, CapitalAIError, normalizeAccountId, toConvoEvent } from "@/lib/capitalai";
import { ingestConvoEvent } from "@/lib/ingest";
import { isFinal } from "@/lib/qualify";

const STATE_KEY = "sync:capitalai";
const FIRST_RUN_LOOKBACK_MS = 3 * 24 * 3600_000;
const OVERLAP_MS = 2 * 3600_000; // re-scan the last 2h so late updates are never missed
const MAX_PAGES = 50; // 100 conversations per page

export type SyncSummary = {
  since: string;
  listed: number;
  ours: number;
  notOurs: number; // accountId isn't in our Telegram pool (e.g. other platforms on the same license)
  skippedFinal: number; // already QUALIFIED/REJECTED here: no transcript fetch needed
  noFanMessage: number;
  byStatus: Partial<Record<ConvoStatus, number>>;
  unchanged: number;
  errors: { conversationId: number; error: string }[];
  complete: boolean; // false = stopped at the time budget; next run continues
};

export type SyncState = {
  cursor?: string | null;
  lockedUntil?: string | null;
  lastRun?: { at: string; ok: boolean; durationMs: number; error?: string; summary?: SyncSummary };
};

export async function getSyncState(): Promise<SyncState> {
  const row = await db.setting.findUnique({ where: { key: STATE_KEY } });
  return (row?.value as SyncState | undefined) ?? {};
}

/** Lease so overlapping runs (slow run + next cron tick) never work at the same time. */
async function acquire(now: Date, holdMs: number): Promise<boolean> {
  await db.$executeRaw`INSERT INTO "Setting" (key, value) VALUES (${STATE_KEY}, '{}'::jsonb) ON CONFLICT (key) DO NOTHING`;
  const until = new Date(now.getTime() + holdMs).toISOString();
  const got = await db.$executeRaw`
    UPDATE "Setting" SET value = value || jsonb_build_object('lockedUntil', ${until}::text)
    WHERE key = ${STATE_KEY}
      AND (value->>'lockedUntil' IS NULL OR (value->>'lockedUntil')::timestamptz < ${now.toISOString()}::timestamptz)`;
  return got === 1;
}

async function release(patch: Partial<SyncState>) {
  const state = await getSyncState();
  await db.setting.update({
    where: { key: STATE_KEY },
    data: { value: JSON.parse(JSON.stringify({ ...state, ...patch, lockedUntil: null })) },
  });
}

export async function syncCapitalAI(opts: { now?: Date; budgetMs?: number; since?: Date } = {}): Promise<
  { ok: true; summary: SyncSummary } | { ok: false; error: string; busy?: boolean }
> {
  const now = opts.now ?? new Date();
  const budgetMs = opts.budgetMs ?? 45_000;
  const started = Date.now();
  if (!(await acquire(now, budgetMs + 60_000))) return { ok: false, busy: true, error: "A sync is already running." };

  const state = await getSyncState();
  const since =
    opts.since ?? (state.cursor ? new Date(new Date(state.cursor).getTime() - OVERLAP_MS) : new Date(now.getTime() - FIRST_RUN_LOOKBACK_MS));
  const summary: SyncSummary = {
    since: since.toISOString(),
    listed: 0,
    ours: 0,
    notOurs: 0,
    skippedFinal: 0,
    noFanMessage: 0,
    byStatus: {},
    unchanged: 0,
    errors: [],
    complete: true,
  };

  try {
    const pool = new Map((await db.tgAccount.findMany({ select: { username: true } })).map((a) => [a.username.toLowerCase(), a.username]));
    const client = capitalAI();

    pages: for (let page = 0, hasMore = true; hasMore; page++) {
      if (page >= MAX_PAGES) {
        summary.complete = false;
        break;
      }
      const res = await client.search({ startDate: since, offset: page * 100 });
      hasMore = res.hasMore;

      for (const row of res.rows) {
        if (Date.now() - started > budgetMs) {
          summary.complete = false;
          break pages;
        }
        summary.listed++;
        const account = pool.get(normalizeAccountId(row.accountId ?? ""));
        if (!account) {
          summary.notOurs++;
          continue;
        }
        summary.ours++;

        const existing = await db.convo.findUnique({
          where: { accountRef_peerId: { accountRef: account, peerId: String(row.identifier) } },
          select: { status: true },
        });
        if (existing && isFinal(existing.status)) {
          summary.skippedFinal++;
          continue;
        }

        try {
          const conv = await client.conversation(row.conversation_id);
          const event = conv ? toConvoEvent(conv, account) : null;
          if (!event) {
            summary.noFanMessage++;
            continue;
          }
          const r = await ingestConvoEvent(event, { via: "capitalai" });
          if (!r.ok) summary.errors.push({ conversationId: row.conversation_id, error: r.error });
          else if (!r.data.changed) summary.unchanged++;
          else summary.byStatus[r.data.status] = (summary.byStatus[r.data.status] ?? 0) + 1;
        } catch (e) {
          // A licence/auth problem stops the run; anything else is per-conversation.
          if (e instanceof CapitalAIError && (e.status === 400 || e.status === 401 || e.status === 403)) throw e;
          summary.errors.push({ conversationId: row.conversation_id, error: e instanceof Error ? e.message : String(e) });
        }
      }
    }

    await release({
      // Only move the cursor after a complete pass; a partial run re-scans from the same point.
      cursor: summary.complete ? now.toISOString() : (state.cursor ?? null),
      lastRun: { at: now.toISOString(), ok: true, durationMs: Date.now() - started, summary },
    });
    return { ok: true, summary };
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    await release({ lastRun: { at: now.toISOString(), ok: false, durationMs: Date.now() - started, error } });
    return { ok: false, error };
  }
}
