// Weeks, locking, payouts and wallets (PLAN.md §1, §7). Sending is manual: export → pay from the
// agency wallet → paste tx hashes. No private keys anywhere.
import type { Prisma, Role } from "@prisma/client";
import { db } from "@/lib/db";
import { audit } from "@/lib/audit";
import { fail, type Result } from "@/lib/action-result";
import type { CurrentUser } from "@/lib/auth/session";
import { getSetting } from "@/lib/settings";
import { normalizeTxHash, normalizeWallet } from "@/lib/wallet";
import { weekBounds } from "@/lib/weeks";

class PayoutError extends Error {}

// ── Wallet ────────────────────────────────────────────────────────────────

export async function setWallet(actor: CurrentUser, input: string): Promise<Result<{ walletAddress: string }>> {
  if (actor.role === "DIRECTOR") return fail("The Director doesn't receive payouts.");
  const wallet = normalizeWallet(input);
  if (!wallet) return fail("Enter a wallet address: 0x followed by 40 hex characters.");

  await db.$transaction(async (tx) => {
    const before = await tx.user.findUniqueOrThrow({ where: { id: actor.id }, select: { walletAddress: true } });
    if (before.walletAddress === wallet) return;
    await tx.user.update({ where: { id: actor.id }, data: { walletAddress: wallet } });
    // Wallet changes redirect money: always audited with before/after.
    await audit(tx, { actorId: actor.id, action: "wallet.set", target: actor.id, meta: { before: before.walletAddress, after: wallet } });
  });
  return { ok: true, data: { walletAddress: wallet } };
}

// ── Lock ──────────────────────────────────────────────────────────────────

export type LockSummary = { weekId: string; payouts: number; totalCents: number; alreadyLocked: boolean };

/**
 * Locks a finished week and generates its payouts, in one transaction.
 * Payouts come from the week's QUALIFIED convos and their snapshotted rates; wallets are snapshotted now.
 */
export async function lockWeek(actorId: string | null, weekId: string, now = new Date()): Promise<Result<LockSummary>> {
  try {
    const summary = await db.$transaction(async (tx) => {
      // FOR UPDATE: waits for any ingest holding FOR SHARE on this week, and blocks new ones until we commit.
      const [week] = await tx.$queryRaw<{ id: string; status: string; endsAt: Date }[]>`
        SELECT id, status, "endsAt" FROM "Week" WHERE id = ${weekId} FOR UPDATE`;
      if (!week) throw new PayoutError("Week not found.");
      if (week.status !== "OPEN") {
        const p = await tx.payout.aggregate({ where: { weekId }, _count: true, _sum: { amountCents: true } });
        return { weekId, payouts: p._count, totalCents: p._sum.amountCents ?? 0, alreadyLocked: true };
      }
      if (week.endsAt > now) throw new PayoutError("This week hasn't finished yet.");

      const where: Prisma.ConvoWhereInput = { weekId, status: "QUALIFIED" };
      const lines: { userId: string; role: Role; convos: number; amountCents: number }[] = [];
      const collect = async (field: "vaId" | "leadVaId" | "leadManagerId", sum: "vaCents" | "leadVaCents" | "lmCents", role: Role) => {
        const groups = await tx.convo.groupBy({ by: [field], where, _count: true, _sum: { [sum]: true } });
        for (const g of groups) {
          const userId = g[field];
          const amountCents = (g._sum as Record<string, number | null>)[sum] ?? 0;
          if (userId && amountCents > 0) lines.push({ userId, role, convos: g._count, amountCents });
        }
      };
      await collect("vaId", "vaCents", "VA");
      await collect("leadVaId", "leadVaCents", "LEAD_VA");
      await collect("leadManagerId", "lmCents", "LEAD_MANAGER");

      const wallets = new Map(
        (await tx.user.findMany({ where: { id: { in: lines.map((l) => l.userId) } }, select: { id: true, walletAddress: true } })).map(
          (u) => [u.id, u.walletAddress],
        ),
      );
      await tx.payout.createMany({ data: lines.map((l) => ({ ...l, weekId, walletAddress: wallets.get(l.userId) ?? null })) });
      await tx.week.update({ where: { id: weekId }, data: { status: "LOCKED" } });

      const totalCents = lines.reduce((s, l) => s + l.amountCents, 0);
      await audit(tx, {
        actorId,
        action: "week.lock",
        target: weekId,
        meta: { payouts: lines.length, totalCents, missingWallets: lines.filter((l) => !wallets.get(l.userId)).length },
      });
      return { weekId, payouts: lines.length, totalCents, alreadyLocked: false };
    });
    return { ok: true, data: summary };
  } catch (e) {
    if (e instanceof PayoutError) return fail(e.message);
    throw e;
  }
}

/** Cron + "Lock week" button: locks every finished OPEN week (catches up if a run was missed). */
export async function lockFinishedWeeks(actorId: string | null, now = new Date()) {
  const tz = await getSetting("timezone");
  // Make sure last week exists even if it had no convos, so locking is visible on the weeks list.
  const lastWeek = weekBounds(new Date(weekBounds(now, tz).startsAt.getTime() - 1), tz);
  await db.week.upsert({ where: { startsAt: lastWeek.startsAt }, update: {}, create: lastWeek });

  const due = await db.week.findMany({ where: { status: "OPEN", endsAt: { lte: now } }, orderBy: { startsAt: "asc" }, select: { id: true } });
  const results: LockSummary[] = [];
  for (const w of due) {
    const r = await lockWeek(actorId, w.id, now);
    if (r.ok) results.push(r.data);
  }
  return results;
}

// ── Paying ────────────────────────────────────────────────────────────────

/** Records a manual payment. When every payout in the week is SENT, the week becomes PAID. */
export async function markPayoutPaid(actor: CurrentUser, payoutId: string, txHashInput: string): Promise<Result<null>> {
  if (actor.role !== "DIRECTOR") return fail("Only the Director can mark payouts paid.");
  const txHash = normalizeTxHash(txHashInput);
  if (!txHash) return fail("Paste the transaction hash (64 hex characters).");

  try {
    await db.$transaction(async (tx) => {
      const [p] = await tx.$queryRaw<{ id: string; weekId: string; status: string; walletAddress: string | null }[]>`
        SELECT id, "weekId", status, "walletAddress" FROM "Payout" WHERE id = ${payoutId} FOR UPDATE`;
      if (!p) throw new PayoutError("Payout not found.");
      if (p.status === "SENT") throw new PayoutError("Already marked paid.");
      if (!p.walletAddress) throw new PayoutError("No wallet on this payout. Use their current wallet first.");

      await tx.payout.update({ where: { id: p.id }, data: { status: "SENT", txHash, paidAt: new Date() } });
      await audit(tx, { actorId: actor.id, action: "payout.paid", target: p.id, meta: { txHash, wallet: p.walletAddress } });

      const unpaid = await tx.payout.count({ where: { weekId: p.weekId, status: { not: "SENT" } } });
      if (unpaid === 0) {
        await tx.week.update({ where: { id: p.weekId }, data: { status: "PAID" } });
        await audit(tx, { actorId: actor.id, action: "week.paid", target: p.weekId });
      }
    });
    return { ok: true, data: null };
  } catch (e) {
    if (e instanceof PayoutError) return fail(e.message);
    throw e;
  }
}

export async function markPayoutFailed(actor: CurrentUser, payoutId: string): Promise<Result<null>> {
  if (actor.role !== "DIRECTOR") return fail("Only the Director can change payouts.");
  const updated = await db.$transaction(async (tx) => {
    const r = await tx.payout.updateMany({ where: { id: payoutId, status: "PENDING" }, data: { status: "FAILED" } });
    if (r.count) await audit(tx, { actorId: actor.id, action: "payout.failed", target: payoutId });
    return r.count;
  });
  return updated ? { ok: true, data: null } : fail("Only pending payouts can be marked failed.");
}

/** For a payout that isn't sent yet: re-snapshot the user's current wallet (e.g. they added one after the lock). */
export async function refreshPayoutWallet(actor: CurrentUser, payoutId: string): Promise<Result<{ walletAddress: string }>> {
  if (actor.role !== "DIRECTOR") return fail("Only the Director can change payouts.");
  try {
    const wallet = await db.$transaction(async (tx) => {
      const p = await tx.payout.findUnique({ where: { id: payoutId }, select: { status: true, walletAddress: true, user: { select: { walletAddress: true } } } });
      if (!p) throw new PayoutError("Payout not found.");
      if (p.status === "SENT") throw new PayoutError("Already paid; the wallet can't change.");
      if (!p.user.walletAddress) throw new PayoutError("They still haven't set a wallet.");
      await tx.payout.update({ where: { id: payoutId }, data: { walletAddress: p.user.walletAddress, status: "PENDING" } });
      await audit(tx, { actorId: actor.id, action: "payout.wallet_refresh", target: payoutId, meta: { before: p.walletAddress, after: p.user.walletAddress } });
      return p.user.walletAddress;
    });
    return { ok: true, data: { walletAddress: wallet } };
  } catch (e) {
    if (e instanceof PayoutError) return fail(e.message);
    throw e;
  }
}

// ── Export ────────────────────────────────────────────────────────────────

/** CSV cell: quoted, and neutralised if it could be read as a spreadsheet formula. */
export function csvCell(value: string | number | null | undefined): string {
  let s = value === null || value === undefined ? "" : String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
}
