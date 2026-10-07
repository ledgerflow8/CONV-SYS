// The convo pipeline (PLAN.md §4). The ONLY code that writes Convo.status.
// Every entry point (API, CSV import, review queue) goes through this module.
import { z } from "zod";
import type { ConvoStatus, CountrySrc, Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { audit } from "@/lib/audit";
import { fail, isUniqueViolation, type Result } from "@/lib/action-result";
import type { CurrentUser } from "@/lib/auth/session";
import { isBlockedDomain, normalizeDomain } from "@/lib/clicks";
import { countryFromPhone, decide, isFinal } from "@/lib/qualify";
import { getAllSettings } from "@/lib/settings";
import type { Settings } from "@/lib/settings-defaults";
import { weekBounds, weekFor } from "@/lib/weeks";

// ── Input ─────────────────────────────────────────────────────────────────

// ISO 8601 with an explicit zone. A bare "2026-10-07 14:00" is ambiguous, so it's refused.
const ISO_WITH_ZONE = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,6})?)?(?:Z|[+-]\d{2}:?\d{2})$/i;
const isoDate = z
  .string()
  .trim()
  .regex(ISO_WITH_ZONE, "must be ISO 8601 with a timezone, e.g. 2026-10-07T14:05:00Z")
  .transform((s, ctx) => {
    const d = new Date(s.replace(" ", "T"));
    if (Number.isNaN(d.getTime())) {
      ctx.addIssue({ code: "custom", message: "is not a real date" });
      return z.NEVER;
    }
    return d;
  });
const optional = <T extends z.ZodTypeAny>(s: T) =>
  z.preprocess((v) => (v === "" || v === null ? undefined : v), s.optional());

export const convoEventSchema = z
  .object({
    tgAccount: z.string().trim().min(1).max(64),
    peerId: z.string().trim().min(1).max(64),
    peerPhone: optional(z.string().trim().max(32)),
    firstMsgAt: isoDate,
    repliedAt: optional(isoDate),
    source: optional(z.string().trim().max(253)),
  })
  .superRefine((e, ctx) => {
    // Runs even when a field already failed; only check dates that actually parsed.
    if (!(e.firstMsgAt instanceof Date) || (e.repliedAt !== undefined && !(e.repliedAt instanceof Date))) return;
    const future = Date.now() + 5 * 60 * 1000;
    if (e.firstMsgAt.getTime() > future) ctx.addIssue({ code: "custom", path: ["firstMsgAt"], message: "is in the future" });
    if (e.repliedAt && e.repliedAt.getTime() > future) ctx.addIssue({ code: "custom", path: ["repliedAt"], message: "is in the future" });
    if (e.repliedAt && e.repliedAt < e.firstMsgAt) {
      ctx.addIssue({ code: "custom", path: ["repliedAt"], message: "is before firstMsgAt" });
    }
  });

export type ConvoEvent = z.input<typeof convoEventSchema>;
type ParsedEvent = z.output<typeof convoEventSchema>;

export type IngestOutcome = {
  convoId: string;
  status: ConvoStatus;
  reason: string | null;
  changed: boolean; // status changed (or convo created) by this event
  late: boolean; // qualified into the current week because its own week was locked
};

type Via = "api" | "csv" | "retry" | "review";

export function formatEventError(error: z.ZodError): string {
  return error.issues.map((i) => `${i.path.join(".") || "event"} ${i.message}`).join("; ");
}

// ── Helpers ───────────────────────────────────────────────────────────────

/** Week for a qualified convo: the week containing repliedAt, or the first open week from now if that one is locked. */
async function payWeek(tx: Prisma.TransactionClient, repliedAt: Date, timeZone: string) {
  const intended = await weekFor(tx, repliedAt, timeZone);
  if (intended.status === "OPEN") return { week: intended, late: false, intended };
  let at = new Date();
  for (let i = 0; i < 4; i++) {
    const w = await weekFor(tx, at, timeZone);
    if (w.status === "OPEN") return { week: w, late: true, intended };
    at = weekBounds(at, timeZone).endsAt;
  }
  throw new Error("No open pay week found");
}

function rateSnapshot(settings: Settings, ids: { vaId: string | null; leadVaId: string | null; leadManagerId: string | null }) {
  return {
    vaCents: ids.vaId ? settings.rates.va : 0,
    leadVaCents: ids.leadVaId ? settings.rates.leadVa : 0,
    lmCents: ids.leadManagerId ? settings.rates.lm : 0,
  };
}

async function lockConvo(tx: Prisma.TransactionClient, where: { accountRef: string; peerId: string } | { id: string }) {
  const rows =
    "id" in where
      ? await tx.$queryRaw<{ id: string }[]>`SELECT id FROM "Convo" WHERE id = ${where.id} FOR UPDATE`
      : await tx.$queryRaw<{ id: string }[]>`
          SELECT id FROM "Convo" WHERE "accountRef" = ${where.accountRef} AND "peerId" = ${where.peerId} FOR UPDATE`;
  return rows[0] ? tx.convo.findUniqueOrThrow({ where: { id: rows[0].id } }) : null;
}

async function auditStatus(
  tx: Prisma.TransactionClient,
  convoId: string,
  actorId: string | null,
  from: ConvoStatus | null,
  to: ConvoStatus,
  reason: string | null,
  via: Via,
  late?: { intendedWeekId: string; weekId: string },
) {
  await audit(tx, { actorId, action: "convo.status", target: convoId, meta: { from, to, reason, via, late: !!late } });
  if (late) await audit(tx, { actorId, action: "convo.late", target: convoId, meta: late });
}

// ── Ingest ────────────────────────────────────────────────────────────────

export async function ingestConvoEvent(
  raw: unknown,
  ctx: { via: Via; actorId?: string | null },
): Promise<Result<IngestOutcome>> {
  const parsed = convoEventSchema.safeParse(raw);
  if (!parsed.success) return fail(formatEventError(parsed.error));
  const settings = await getAllSettings();

  // Two events for the same person can race to create the row; the loser retries and updates it.
  for (let attempt = 0; ; attempt++) {
    try {
      return { ok: true, data: await db.$transaction((tx) => ingestOnce(tx, parsed.data, settings, ctx)) };
    } catch (e) {
      if (isUniqueViolation(e) && attempt < 2) continue;
      throw e;
    }
  }
}

async function ingestOnce(
  tx: Prisma.TransactionClient,
  e: ParsedEvent,
  settings: Settings,
  ctx: { via: Via; actorId?: string | null },
): Promise<IngestOutcome> {
  const actorId = ctx.actorId ?? null;

  // 1. Find the account (by username, or by id).
  const input = e.tgAccount.replace(/^@/, "");
  const account = await tx.tgAccount.findFirst({
    where: { OR: [{ username: input.toLowerCase() }, { id: input }] },
    select: { id: true, username: true, modelId: true },
  });
  const accountRef = account?.username ?? input.toLowerCase();

  // 3 (early). Lock the existing row for this person on this account, if any.
  const existing = await lockConvo(tx, { accountRef, peerId: e.peerId });

  // Merge with what we already know. Later events fill gaps; they never erase.
  const firstMsgAt = existing && existing.firstMsgAt < e.firstMsgAt ? existing.firstMsgAt : e.firstMsgAt;
  const repliedAt = existing?.repliedAt ?? e.repliedAt ?? null;
  const peerPhone = existing?.peerPhone ?? e.peerPhone ?? null;
  const eventSource = existing?.source ?? e.source ?? null;

  // A decided convo never changes outcome: it counts exactly once.
  if (existing && isFinal(existing.status)) {
    await tx.convo.update({
      where: { id: existing.id },
      data: { peerPhone, tgAccountId: existing.tgAccountId ?? account?.id ?? null },
    });
    return {
      convoId: existing.id,
      status: existing.status,
      reason: existing.rejectReason ?? existing.reviewReason,
      changed: false,
      late: false,
    };
  }

  // 2. Attribute: who held the account when the first message arrived, then walk up the tree.
  const assignment = account
    ? await tx.tgAssignment.findFirst({
        where: {
          tgAccountId: account.id,
          startedAt: { lte: firstMsgAt },
          OR: [{ endedAt: null }, { endedAt: { gt: firstMsgAt } }],
        },
        orderBy: { startedAt: "desc" },
        select: { va: { select: { id: true, parentId: true, parent: { select: { parentId: true } } } } },
      })
    : null;
  const vaId = assignment?.va.id ?? null;
  const leadVaId = assignment?.va.parentId ?? null;
  const leadManagerId = assignment?.va.parent?.parentId ?? null;

  // 4. Country: phone prefix, else the VA's most recent click to this account within the window.
  let country: string | null = countryFromPhone(peerPhone);
  let countrySource: CountrySrc = country ? "PHONE" : "UNKNOWN";
  let click: { id: string; country: string | null; blocked: boolean; refDomain: string | null } | null = null;
  if (account && vaId) {
    click = await tx.linkClick.findFirst({
      where: {
        vaId,
        tgAccountId: account.id,
        createdAt: { gte: new Date(firstMsgAt.getTime() - settings.clickMatchWindowMin * 60_000), lte: firstMsgAt },
      },
      orderBy: { createdAt: "desc" },
      select: { id: true, country: true, blocked: true, refDomain: true },
    });
  }
  if (!country && click?.country) {
    country = click.country;
    countrySource = "CLICK";
  }

  // 5. Source: a blocked click, or a source domain the event itself reports.
  const reportedDomain = normalizeDomain(eventSource ?? "");
  const blockedSource = !!click?.blocked || isBlockedDomain(reportedDomain, settings.blockedDomains);
  const source = click?.refDomain ?? reportedDomain ?? eventSource;

  // 6. Decide.
  const decision = decide({
    accountKnown: !!account,
    attributed: !!vaId,
    country,
    tier1: settings.tier1Countries,
    blockedSource,
    replied: !!repliedAt,
  });

  let qualified: { weekId: string; qualifiedAt: Date; cents: ReturnType<typeof rateSnapshot> } | null = null;
  let late: { intendedWeekId: string; weekId: string } | undefined;
  if (decision.status === "QUALIFIED") {
    const w = await payWeek(tx, repliedAt!, settings.timezone);
    if (w.late) late = { intendedWeekId: w.intended.id, weekId: w.week.id };
    qualified = { weekId: w.week.id, qualifiedAt: new Date(), cents: rateSnapshot(settings, { vaId, leadVaId, leadManagerId }) };
  }

  const data = {
    accountRef,
    tgAccountId: account?.id ?? null,
    peerId: e.peerId,
    peerPhone,
    vaId,
    leadVaId,
    leadManagerId,
    modelId: account?.modelId ?? null,
    weekId: qualified?.weekId ?? null,
    country,
    countrySource,
    clickId: click?.id ?? null,
    source,
    firstMsgAt,
    repliedAt,
    status: decision.status,
    rejectReason: decision.status === "REJECTED" ? decision.rejectReason : null,
    reviewReason: decision.status === "REVIEW" ? decision.reviewReason : null,
    qualifiedAt: qualified?.qualifiedAt ?? null,
    vaCents: qualified?.cents.vaCents ?? 0,
    leadVaCents: qualified?.cents.leadVaCents ?? 0,
    lmCents: qualified?.cents.lmCents ?? 0,
  };

  const convo = existing
    ? await tx.convo.update({ where: { id: existing.id }, data })
    : await tx.convo.create({ data });

  const reason = data.rejectReason ?? data.reviewReason;
  const changed = !existing || existing.status !== convo.status || existing.reviewReason !== convo.reviewReason;
  // 7. Audit every status change.
  if (changed) await auditStatus(tx, convo.id, actorId, existing?.status ?? null, convo.status, reason, ctx.via, late);

  return { convoId: convo.id, status: convo.status, reason, changed, late: !!late };
}

// ── Review queue (Director) ───────────────────────────────────────────────

/** Approve or reject a convo in REVIEW. Approval is only for unknown-country convos. */
export async function reviewConvo(
  actor: CurrentUser,
  convoId: string,
  decision: "approve" | "reject",
): Promise<Result<IngestOutcome>> {
  if (actor.role !== "DIRECTOR") return fail("Only the Director can review convos.");
  const settings = await getAllSettings();

  try {
    const outcome = await db.$transaction(async (tx) => {
      const convo = await lockConvo(tx, { id: convoId });
      if (!convo || convo.status !== "REVIEW") throw new ReviewError("This convo isn't waiting for review any more.");

      if (decision === "reject") {
        await tx.convo.update({ where: { id: convo.id }, data: { status: "REJECTED", rejectReason: "review_rejected", reviewReason: null } });
        await auditStatus(tx, convo.id, actor.id, "REVIEW", "REJECTED", "review_rejected", "review");
        return { convoId: convo.id, status: "REJECTED" as const, reason: "review_rejected", changed: true, late: false };
      }

      if (convo.reviewReason !== "unknown_country" || !convo.vaId || !convo.repliedAt) {
        throw new ReviewError("Only unknown-country convos can be approved. Fix the account or assignment, then Retry.");
      }
      const w = await payWeek(tx, convo.repliedAt, settings.timezone);
      const late = w.late ? { intendedWeekId: w.intended.id, weekId: w.week.id } : undefined;
      await tx.convo.update({
        where: { id: convo.id },
        data: {
          status: "QUALIFIED",
          reviewReason: null,
          countrySource: "MANUAL",
          weekId: w.week.id,
          qualifiedAt: new Date(),
          ...rateSnapshot(settings, convo),
        },
      });
      await auditStatus(tx, convo.id, actor.id, "REVIEW", "QUALIFIED", "review_approved", "review", late);
      return { convoId: convo.id, status: "QUALIFIED" as const, reason: null, changed: true, late: !!late };
    });
    return { ok: true, data: outcome };
  } catch (e) {
    if (e instanceof ReviewError) return fail(e.message);
    throw e;
  }
}

/** Re-runs ingest for a REVIEW convo with its stored data (e.g. after the account was added to the pool). */
export async function retryConvo(actor: CurrentUser, convoId: string): Promise<Result<IngestOutcome>> {
  if (actor.role !== "DIRECTOR") return fail("Only the Director can review convos.");
  const c = await db.convo.findUnique({ where: { id: convoId } });
  if (!c || c.status !== "REVIEW") return fail("This convo isn't waiting for review any more.");
  return ingestConvoEvent(
    {
      tgAccount: c.accountRef,
      peerId: c.peerId,
      peerPhone: c.peerPhone,
      firstMsgAt: c.firstMsgAt.toISOString(),
      repliedAt: c.repliedAt?.toISOString(),
      source: c.source,
    },
    { via: "retry", actorId: actor.id },
  );
}

class ReviewError extends Error {}
