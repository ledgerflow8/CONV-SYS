// Account-status ingest (PLAN.md §10.1). Record-only: the panel tells us the last-known Telegram
// state of an account; we store it and surface it in the Director's pool, but NEVER change
// TgStatus or VA assignments and never notify. A real ban stays a human action in the pool UI.
import { z } from "zod";
import { db } from "@/lib/db";
import { isUniqueViolation } from "@/lib/action-result";
import { matchTgAccount } from "@/lib/match-account";

const ISO_WITH_ZONE = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,6})?)?(?:Z|[+-]\d{2}:?\d{2})$/i;

const isoAt = z
  .string()
  .trim()
  .regex(ISO_WITH_ZONE, "must be ISO 8601 with a timezone")
  .transform((s, ctx) => {
    const d = new Date(s.replace(" ", "T"));
    if (Number.isNaN(d.getTime())) {
      ctx.addIssue({ code: "custom", message: "is not a real date" });
      return z.NEVER;
    }
    return d;
  });

const optionalStr = (max: number) => z.preprocess((v) => (v === "" || v === null ? undefined : v), z.string().trim().max(max).optional());
const tgUserId = z.preprocess((v) => (v === "" || v === null ? undefined : v), z.string().trim().regex(/^\d{1,19}$/).optional());

export const accountStatusSchema = z.object({
  tgAccount: z.string().trim().min(1).max(64),
  tgUserId,
  status: z.enum(["online", "offline", "limited", "banned", "revoked", "frozen"]),
  at: isoAt,
  detail: optionalStr(500),
});

// Auto-sync of the panel's accounts into the portal pool (keyed by numeric id). A registered account
// arrives unassigned (no model) until a Director picks one; a retired account is removed from service.
export const accountRegisterSchema = z.object({
  action: z.literal("register"),
  tgUserId: z.string().trim().regex(/^\d{1,19}$/),
  username: z.preprocess((v) => (v === "" ? null : v), z.string().trim().max(64).nullable().optional()),
  phone: optionalStr(32),
  link: optionalStr(255),
});

export const accountRetireSchema = z.object({
  action: z.literal("retire"),
  tgUserId: z.string().trim().regex(/^\d{1,19}$/),
});

// A username change reported by the panel: the portal moves the account's username + t.me link so the
// pool and the assigned VA's tracking link follow. Matched on the stable numeric id (CLAUDE.md §10.1).
export const accountRenameSchema = z.object({
  tgUserId: z.string().trim().regex(/^\d{1,19}$/),
  oldUsername: optionalStr(64),
  newUsername: z.string().trim().min(5).max(32).regex(/^[A-Za-z0-9_]+$/, "must be 5–32 of a–z, 0–9, _"),
  at: isoAt,
});

export type AccountStatusEvent = z.input<typeof accountStatusSchema>;

export type AccountStatusOutcome = { recorded: boolean; reason?: "unknown_account" | "stale" };

export function formatEventError(error: z.ZodError): string {
  return error.issues.map((i) => `${i.path.join(".") || "event"} ${i.message}`).join("; ");
}

/**
 * Record the panel's status for one account. Matches by username (or id), like convo ingest.
 * An unknown account is acknowledged, not rejected, so the panel never piles up failed rows for
 * accounts that aren't in the pool yet. Older reports than what we already have are ignored.
 */
export async function recordAccountStatus(raw: unknown): Promise<{ ok: true; data: AccountStatusOutcome } | { ok: false; error: string }> {
  const parsed = accountStatusSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, error: formatEventError(parsed.error) };
  const e = parsed.data;

  const account = await matchTgAccount(db, { tgUserId: e.tgUserId, tgAccount: e.tgAccount });
  if (!account) return { ok: true, data: { recorded: false, reason: "unknown_account" } };
  if (account.lastSeenAt && account.lastSeenAt > e.at) return { ok: true, data: { recorded: false, reason: "stale" } };

  await db.tgAccount.update({ where: { id: account.id }, data: { panelStatus: e.status, lastSeenAt: e.at } });
  return { ok: true, data: { recorded: true } };
}

/**
 * Apply a username change: move the account's username and t.me link. Matched by numeric id (with a
 * fallback to the old username), so it works even before the id has been backfilled. The assigned VA's
 * tracking link and dashboard follow automatically because they key off the account, not the name.
 */
export async function renameAccount(raw: unknown): Promise<{ ok: true; data: AccountStatusOutcome } | { ok: false; error: string }> {
  const parsed = accountRenameSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, error: formatEventError(parsed.error) };
  const e = parsed.data;

  const account = await matchTgAccount(db, { tgUserId: e.tgUserId, tgAccount: e.oldUsername ?? null });
  if (!account) return { ok: true, data: { recorded: false, reason: "unknown_account" } };

  const username = e.newUsername.toLowerCase();
  if (account.username === username) return { ok: true, data: { recorded: true } };
  try {
    await db.tgAccount.update({ where: { id: account.id }, data: { username, link: `https://t.me/${username}` } });
  } catch (err) {
    if (isUniqueViolation(err)) return { ok: false, error: `username @${username} is already used by another account` };
    throw err;
  }
  return { ok: true, data: { recorded: true } };
}

/**
 * Register (create or refresh) an account in the pool, keyed by numeric id. New accounts arrive
 * UNASSIGNED (no model); a Director sets the model later. Username/phone/link are kept current. A new
 * account is AVAILABLE, but it's only actually claimable once it has BOTH a model and a username
 * (claimAvailableAccount enforces that) — so a no-username account stays effectively out of the pool.
 * Never touches the model, status or holder of an account that already exists.
 */
export async function registerAccount(raw: unknown): Promise<{ ok: true; data: AccountStatusOutcome } | { ok: false; error: string }> {
  const parsed = accountRegisterSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, error: formatEventError(parsed.error) };
  const e = parsed.data;
  const tgUserId = BigInt(e.tgUserId);
  const username = e.username ? e.username.replace(/^@/, "").toLowerCase() : null;

  const existing = await db.tgAccount.findFirst({
    where: { OR: [{ tgUserId }, ...(username ? [{ username }] : [])] },
    select: { id: true },
  });
  try {
    if (existing) {
      await db.tgAccount.update({ where: { id: existing.id }, data: { tgUserId, username, phone: e.phone, link: e.link } });
    } else {
      await db.tgAccount.create({
        data: { tgUserId, username, phone: e.phone ?? "", link: e.link ?? "", status: "AVAILABLE" },
      });
    }
  } catch (err) {
    if (isUniqueViolation(err)) return { ok: false, error: "account conflicts with an existing username/id" };
    throw err;
  }
  return { ok: true, data: { recorded: true } };
}

/** Retire an account removed from the panel: mark RETIRED and release any holder. */
export async function retireAccount(raw: unknown): Promise<{ ok: true; data: AccountStatusOutcome } | { ok: false; error: string }> {
  const parsed = accountRetireSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, error: formatEventError(parsed.error) };
  const account = await matchTgAccount(db, { tgUserId: parsed.data.tgUserId });
  if (!account) return { ok: true, data: { recorded: false, reason: "unknown_account" } };
  await db.$transaction(async (tx) => {
    await tx.tgAssignment.updateMany({ where: { tgAccountId: account.id, endedAt: null }, data: { endedAt: new Date(), endReason: "retired" } });
    await tx.tgAccount.update({ where: { id: account.id }, data: { status: "RETIRED", vaId: null } });
  });
  return { ok: true, data: { recorded: true } };
}

/** Route entry point: dispatch by shape — register / retire (action), rename (newUsername), else status. */
export async function applyAccountEvent(raw: unknown): Promise<{ ok: true; data: AccountStatusOutcome } | { ok: false; error: string }> {
  if (raw && typeof raw === "object") {
    const action = (raw as { action?: unknown }).action;
    if (action === "register") return registerAccount(raw);
    if (action === "retire") return retireAccount(raw);
    if ("newUsername" in raw) return renameAccount(raw);
  }
  return recordAccountStatus(raw);
}
