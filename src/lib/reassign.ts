// Ban / retire / restore Telegram accounts and (re)assign VAs (PLAN.md §5).
// Ban/retire: Director only (PLAN.md §9). The VA's tracking link follows them to the new account.
import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { audit } from "@/lib/audit";
import { fail, type Result } from "@/lib/action-result";
import type { CurrentUser } from "@/lib/auth/session";
import { notifyAccountChange, type NotifyResult } from "@/lib/notify";
import { claimAvailableAccount } from "@/lib/team";

class Abort extends Error {}

export type TakeOutcome = {
  vaId: string | null; // who held it
  replacement: string | null; // new account username, if one was free
  notified: NotifyResult | null;
};

async function lockAccount(tx: Prisma.TransactionClient, id: string) {
  const [row] = await tx.$queryRaw<{ id: string; status: string; vaId: string | null; modelId: string; username: string }[]>`
    SELECT id, status, "vaId", "modelId", username FROM "TgAccount" WHERE id = ${id} FOR UPDATE`;
  return row ?? null;
}

/** Gives a VA the next free account for their model. Returns its username, or null if the pool is empty. */
async function assignNext(tx: Prisma.TransactionClient, vaId: string, modelId: string) {
  const next = await claimAvailableAccount(tx, modelId);
  if (!next) return null;
  await tx.tgAccount.update({ where: { id: next.id }, data: { status: "ASSIGNED", vaId } });
  await tx.tgAssignment.create({ data: { tgAccountId: next.id, vaId } });
  return next.username;
}

/** Ban (or retire) an account. If a VA held it, end that assignment and give them the next free one. */
export async function takeAccountOutOfService(
  actor: CurrentUser,
  accountId: string,
  status: "BANNED" | "RETIRED",
): Promise<Result<TakeOutcome>> {
  if (actor.role !== "DIRECTOR") return fail("Only the Director can ban or retire accounts.");
  const reason = status === "BANNED" ? "banned" : "retired";
  try {
    const out = await db.$transaction(async (tx) => {
      const acct = await lockAccount(tx, accountId);
      if (!acct) throw new Abort("Account not found.");
      if (acct.status === status) throw new Abort(`Already ${reason}.`);

      const vaId = acct.vaId;
      await tx.tgAccount.update({ where: { id: acct.id }, data: { status, vaId: null } });
      let replacement: string | null = null;
      if (vaId) {
        await tx.tgAssignment.updateMany({
          where: { tgAccountId: acct.id, vaId, endedAt: null },
          data: { endedAt: new Date(), endReason: reason },
        });
        const va = await tx.user.findUnique({ where: { id: vaId }, select: { status: true, modelId: true } });
        if (va?.status === "ACTIVE" && va.modelId) replacement = await assignNext(tx, vaId, va.modelId);
      }
      await audit(tx, { actorId: actor.id, action: `tg.${reason}`, target: acct.id, meta: { username: acct.username, vaId, replacement } });
      return { vaId, replacement };
    });
    // After commit: tell the VA. Never undoes the change if it fails.
    const notified = out.vaId ? await notifyAccountChange(out.vaId, reason) : null;
    return { ok: true, data: { ...out, notified } };
  } catch (e) {
    if (e instanceof Abort) return fail(e.message);
    throw e;
  }
}

/** Banned/retired → back to the pool as AVAILABLE (e.g. a ban was appealed). */
export async function restoreAccount(actor: CurrentUser, accountId: string): Promise<Result<null>> {
  if (actor.role !== "DIRECTOR") return fail("Only the Director can restore accounts.");
  try {
    await db.$transaction(async (tx) => {
      const acct = await lockAccount(tx, accountId);
      if (!acct) throw new Abort("Account not found.");
      if (acct.status !== "BANNED" && acct.status !== "RETIRED") throw new Abort("Only banned or retired accounts can be restored.");
      await tx.tgAccount.update({ where: { id: acct.id }, data: { status: "AVAILABLE", vaId: null } });
      await audit(tx, { actorId: actor.id, action: "tg.restore", target: acct.id, meta: { from: acct.status } });
    });
    return { ok: true, data: null };
  } catch (e) {
    if (e instanceof Abort) return fail(e.message);
    throw e;
  }
}

/** Lead VA → "Assign to existing VA": a VA on their team with no account gets the next free one. */
export async function assignAccountToVa(actor: CurrentUser, vaId: string): Promise<Result<{ account: string; notified: NotifyResult }>> {
  if (actor.role !== "LEAD_VA") return fail("Only Lead VAs can assign accounts to their VAs.");
  if (!actor.modelId) return fail("Your team has no model yet.");
  try {
    const account = await db.$transaction(async (tx) => {
      // Lock the VA row so two clicks can't hand out two accounts.
      const [va] = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM "User" WHERE id = ${vaId} AND role = 'VA' AND status = 'ACTIVE' AND "parentId" = ${actor.id} FOR UPDATE`;
      if (!va) throw new Abort("VA not found.");
      if (await tx.tgAccount.findUnique({ where: { vaId } })) throw new Abort("This VA already has an account.");
      const username = await assignNext(tx, vaId, actor.modelId!);
      if (!username) throw new Abort("No Telegram accounts left for this model. Ask your Director to add more.");
      await audit(tx, { actorId: actor.id, action: "va.assign_account", target: vaId, meta: { account: username } });
      return username;
    });
    return { ok: true, data: { account, notified: await notifyAccountChange(vaId, "assigned") } };
  } catch (e) {
    if (e instanceof Abort) return fail(e.message);
    throw e;
  }
}
