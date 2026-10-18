// Organisation changes (client feedback 2026-10-18): fire at every level, move teams between models,
// auto-assign accounts to VAs waiting for one, and bulk "fire inactive VAs".
// Every change runs in one transaction with row locks; bot messages go out after the commit and never
// undo anything. Earnings are never touched: convos keep their snapshotted attribution and locked
// weeks don't change (CLAUDE.md).
import type { Prisma, Role } from "@prisma/client";
import { db } from "@/lib/db";
import { audit } from "@/lib/audit";
import { fail, type Result } from "@/lib/action-result";
import type { CurrentUser } from "@/lib/auth/session";
import { notifyAccountChange } from "@/lib/notify";
import { claimAvailableAccount } from "@/lib/team";

class Abort extends Error {}
type Tx = Prisma.TransactionClient;

// ── Building blocks (inside a transaction) ───────────────────────────────

/** Ends a VA's current account: assignment closed, a healthy account goes back to AVAILABLE. */
async function releaseAccount(tx: Tx, vaId: string, reason: string): Promise<{ modelId: string | null } | null> {
  const acct = await tx.tgAccount.findUnique({ where: { vaId }, select: { id: true, status: true, modelId: true } });
  if (!acct) return null;
  await tx.tgAssignment.updateMany({ where: { tgAccountId: acct.id, vaId, endedAt: null }, data: { endedAt: new Date(), endReason: reason } });
  // A banned or retired account stays out of the pool.
  await tx.tgAccount.update({ where: { id: acct.id }, data: { vaId: null, ...(acct.status === "ASSIGNED" ? { status: "AVAILABLE" } : {}) } });
  return { modelId: acct.status === "ASSIGNED" ? acct.modelId : null };
}

/** Gives a VA the next free account of a model. Null = none free (the VA now "needs an account"). */
async function assignFrom(tx: Tx, vaId: string, modelId: string): Promise<string | null> {
  const next = await claimAvailableAccount(tx, modelId);
  if (!next) return null;
  await tx.tgAccount.update({ where: { id: next.id }, data: { status: "ASSIGNED", vaId } });
  await tx.tgAssignment.create({ data: { tgAccountId: next.id, vaId } });
  return next.username;
}

/** Fires one person: login blocked (and every session ended), tracking link off, invites voided, account released. */
async function fireOne(tx: Tx, userId: string): Promise<{ freedModel: string | null }> {
  const r = await tx.user.updateMany({
    where: { id: userId, status: "ACTIVE" },
    data: { status: "FIRED", firedAt: new Date(), sessionVersion: { increment: 1 } },
  });
  if (r.count === 0) return { freedModel: null };
  await tx.trackingLink.updateMany({ where: { vaId: userId }, data: { active: false } });
  await tx.inviteToken.updateMany({ where: { userId, usedAt: null }, data: { expiresAt: new Date(), passwordEnc: null } });
  const released = await releaseAccount(tx, userId, "fired");
  return { freedModel: released?.modelId ?? null };
}

/** Moves a VA to another model: old account back to its pool, next free one from the new pool. */
async function moveVaToModel(tx: Tx, vaId: string, modelId: string) {
  const released = await releaseAccount(tx, vaId, "moved");
  await tx.user.update({ where: { id: vaId }, data: { modelId } });
  const account = await assignFrom(tx, vaId, modelId);
  return { vaId, account, freedModel: released?.modelId ?? null };
}

/** Claimable = free, has a username (the panel registers accounts before they have one). */
function claimableIn(tx: Tx | typeof db, modelId: string) {
  return tx.tgAccount.count({ where: { modelId, status: "AVAILABLE", vaId: null, username: { not: null } } });
}

async function lockUser(tx: Tx, id: string) {
  const [row] = await tx.$queryRaw<{ id: string; role: Role; status: string; parentId: string | null; modelId: string | null; username: string }[]>`
    SELECT id, role, status, "parentId", "modelId", username FROM "User" WHERE id = ${id} FOR UPDATE`;
  return row ?? null;
}

// ── Accounts for VAs that are waiting for one ───────────────────────────

/**
 * Gives free accounts of a model to its active VAs that have none, longest-waiting first, and tells
 * them on Telegram. Called after anything that frees or adds accounts. Safe to call any time.
 */
export async function refillWaitingVas(modelId: string | null | undefined): Promise<{ vaId: string; account: string }[]> {
  if (!modelId) return [];
  const given: { vaId: string; account: string }[] = [];
  for (let i = 0; i < 1000; i++) {
    const r = await db.$transaction(async (tx) => {
      const [va] = await tx.$queryRaw<{ id: string }[]>`
        SELECT u.id FROM "User" u
        WHERE u.role = 'VA' AND u.status = 'ACTIVE' AND u."modelId" = ${modelId}
          AND NOT EXISTS (SELECT 1 FROM "TgAccount" a WHERE a."vaId" = u.id)
        ORDER BY u."createdAt" LIMIT 1 FOR UPDATE SKIP LOCKED`;
      if (!va) return null;
      const account = await assignFrom(tx, va.id, modelId);
      if (!account) return null;
      await audit(tx, { actorId: null, action: "va.auto_assign", target: va.id, meta: { account } });
      return { vaId: va.id, account };
    });
    if (!r) break;
    given.push(r);
  }
  for (const g of given) await notifyAccountChange(g.vaId, "assigned");
  return given;
}

// ── Firing ───────────────────────────────────────────────────────────────

export type FirePlan = {
  target: { id: string; username: string; role: Role };
  under: { id: string; username: string; role: Role }[]; // direct reports who'd be affected
  underTotal: number; // everyone below, at any depth
  moveTargets: { id: string; username: string; model: string | null }[]; // where the direct reports can go
};

function canFire(actor: CurrentUser, target: { role: Role; parentId: string | null; id: string }): boolean {
  if (target.id === actor.id || target.role === "DIRECTOR") return false;
  if (actor.role === "DIRECTOR") return true;
  if (actor.role === "LEAD_MANAGER") return target.role === "LEAD_VA" && target.parentId === actor.id;
  if (actor.role === "LEAD_VA") return target.role === "VA" && target.parentId === actor.id;
  return false;
}

/** What firing someone would affect, and where their people could be moved. Shown before confirming. */
export async function planFire(actor: CurrentUser, targetId: string): Promise<Result<FirePlan>> {
  const target = await db.user.findUnique({ where: { id: targetId }, select: { id: true, username: true, role: true, status: true, parentId: true } });
  if (!target || target.status !== "ACTIVE" || !canFire(actor, target)) return fail("Person not found.");
  const under = await db.user.findMany({
    where: { parentId: target.id, status: "ACTIVE" },
    orderBy: { username: "asc" },
    select: { id: true, username: true, role: true },
  });
  const underTotal =
    under.length + (target.role === "LEAD_MANAGER" ? await db.user.count({ where: { status: "ACTIVE", parent: { parentId: target.id } } }) : 0);
  // Reports move sideways: to another Lead VA (for a Lead VA's VAs) or Lead Manager (for a Lead Manager's Lead VAs).
  const moveTargets =
    target.role === "VA"
      ? []
      : await db.user.findMany({
          where: {
            role: target.role,
            status: "ACTIVE",
            id: { not: target.id },
            ...(actor.role === "LEAD_MANAGER" ? { parentId: actor.id } : {}),
          },
          orderBy: { username: "asc" },
          select: { id: true, username: true, model: { select: { name: true } } },
        });
  return {
    ok: true,
    data: {
      target: { id: target.id, username: target.username, role: target.role },
      under,
      underTotal,
      moveTargets: moveTargets.map((m) => ({ id: m.id, username: m.username, model: m.model?.name ?? null })),
    },
  };
}

export type FireOptions = { reports?: "fire" | { moveTo: string } };
export type FireOutcome = { fired: number; moved: number; needAccount: number };

/**
 * Fire someone. People under them are fired too or moved to another manager of the same role — the
 * caller must say which when there are any. Moving a Lead VA's VAs to a team on another model swaps
 * their accounts like a team move. Earnings stay where they were.
 */
export async function fireUser(actor: CurrentUser, targetId: string, opts: FireOptions = {}): Promise<Result<FireOutcome>> {
  const freed = new Set<string>();
  const movedVas: { vaId: string; account: string | null }[] = [];
  try {
    const outcome = await db.$transaction(async (tx) => {
      const target = await lockUser(tx, targetId);
      if (!target || target.status !== "ACTIVE" || !canFire(actor, target)) throw new Abort("Person not found.");

      const reports = await tx.user.findMany({ where: { parentId: target.id, status: "ACTIVE" }, select: { id: true, role: true } });
      if (reports.length && !opts.reports) {
        throw new Abort(`Choose what happens to the ${reports.length} ${reports.length === 1 ? "person" : "people"} under them.`);
      }

      let fired = 0;
      let moved = 0;
      if (reports.length && opts.reports === "fire") {
        for (const r of reports) {
          // A Lead Manager's Lead VAs take their own VAs with them.
          const grand = await tx.user.findMany({ where: { parentId: r.id, status: "ACTIVE" }, select: { id: true } });
          for (const g of grand) {
            const f = await fireOne(tx, g.id);
            if (f.freedModel) freed.add(f.freedModel);
            fired++;
          }
          const f = await fireOne(tx, r.id);
          if (f.freedModel) freed.add(f.freedModel);
          fired++;
        }
      } else if (reports.length && typeof opts.reports === "object") {
        const dest = await lockUser(tx, opts.reports.moveTo);
        const destOk =
          dest &&
          dest.status === "ACTIVE" &&
          dest.role === target.role &&
          dest.id !== target.id &&
          (actor.role !== "LEAD_MANAGER" || dest.parentId === actor.id);
        if (!destOk) throw new Abort(`Pick an active ${target.role === "LEAD_VA" ? "Lead VA" : "Lead Manager"} to move them to.`);

        for (const r of reports) {
          await tx.user.update({ where: { id: r.id }, data: { parentId: dest.id } });
          // VAs joining a team on another model swap accounts.
          if (r.role === "VA" && dest.modelId && dest.modelId !== target.modelId) {
            const m = await moveVaToModel(tx, r.id, dest.modelId);
            if (m.freedModel) freed.add(m.freedModel);
            movedVas.push({ vaId: r.id, account: m.account });
          }
          moved++;
        }
      }

      const f = await fireOne(tx, target.id);
      if (f.freedModel) freed.add(f.freedModel);
      fired++;
      await audit(tx, {
        actorId: actor.id,
        action: "user.fire",
        target: target.id,
        meta: {
          role: target.role,
          reports: reports.length ? (opts.reports === "fire" ? "fired" : { movedTo: (opts.reports as { moveTo: string }).moveTo }) : null,
          fired,
          moved,
        },
      });
      return { fired, moved, needAccount: movedVas.filter((m) => !m.account).length };
    });
    for (const m of movedVas) await notifyAccountChange(m.vaId, "moved");
    for (const model of freed) await refillWaitingVas(model);
    return { ok: true, data: outcome };
  } catch (e) {
    if (e instanceof Abort) return fail(e.message);
    throw e;
  }
}

// ── Moving teams between models ──────────────────────────────────────────

export type MovePlan = {
  teams: { id: string; username: string; vas: number }[];
  from: { id: string; name: string } | null;
  to: { id: string; name: string };
  vasMoving: number;
  available: number; // free accounts in the destination pool right now
  alreadyWaiting: number; // VAs on the destination model already waiting for an account
  short: number; // VAs that would be left without an account
};

async function canMoveTeam(actor: CurrentUser, lva: { role: Role; parentId: string | null }) {
  if (lva.role !== "LEAD_VA") return false;
  if (actor.role === "DIRECTOR") return true;
  return actor.role === "LEAD_MANAGER" && lva.parentId === actor.id;
}

async function plan(teams: { id: string; username: string }[], from: { id: string; name: string } | null, to: { id: string; name: string }): Promise<MovePlan> {
  const counts = await Promise.all(teams.map((t) => db.user.count({ where: { parentId: t.id, role: "VA", status: "ACTIVE" } })));
  const vasMoving = counts.reduce((a, b) => a + b, 0);
  const available = await claimableIn(db, to.id);
  const alreadyWaiting = await db.user.count({ where: { role: "VA", status: "ACTIVE", modelId: to.id, tgAccount: null } });
  return {
    teams: teams.map((t, i) => ({ ...t, vas: counts[i] })),
    from,
    to,
    vasMoving,
    available,
    alreadyWaiting,
    short: Math.max(0, vasMoving - available),
  };
}

async function activeModel(modelId: string) {
  return db.model.findFirst({ where: { id: modelId, active: true }, select: { id: true, name: true } });
}

/** Preview of moving one Lead VA's team to another model. */
export async function planTeamMove(actor: CurrentUser, leadVaId: string, toModelId: string): Promise<Result<MovePlan>> {
  const lva = await db.user.findUnique({
    where: { id: leadVaId },
    select: { id: true, username: true, role: true, status: true, parentId: true, model: { select: { id: true, name: true } } },
  });
  if (!lva || lva.status !== "ACTIVE" || !(await canMoveTeam(actor, lva))) return fail("Team not found.");
  const to = await activeModel(toModelId);
  if (!to) return fail("Pick an active model.");
  if (lva.model?.id === to.id) return fail(`This team already works for ${to.name}.`);
  return { ok: true, data: await plan([{ id: lva.id, username: lva.username }], lva.model, to) };
}

/** Preview of the bulk "move all teams from A to B". Director only. */
export async function planBulkMove(actor: CurrentUser, fromModelId: string, toModelId: string): Promise<Result<MovePlan>> {
  if (actor.role !== "DIRECTOR") return fail("Only the Director can move all teams.");
  if (fromModelId === toModelId) return fail("Pick a different model to move to.");
  const [from, to] = await Promise.all([db.model.findUnique({ where: { id: fromModelId }, select: { id: true, name: true } }), activeModel(toModelId)]);
  if (!from) return fail("Model not found.");
  if (!to) return fail("Pick an active model to move to.");
  const teams = await db.user.findMany({
    where: { role: "LEAD_VA", status: "ACTIVE", modelId: from.id },
    orderBy: { username: "asc" },
    select: { id: true, username: true },
  });
  return { ok: true, data: await plan(teams, from, to) };
}

export type MoveOutcome = { teams: number; vas: number; withAccount: number; needAccount: number };

/**
 * Moves a Lead VA's team to another model, in one transaction. If the destination pool is short,
 * nothing happens unless `allowShort` (the Director/Lead Manager saw the shortfall and chose
 * "move anyway"); then VAs without an account wait and get one automatically when accounts free up.
 */
export async function moveTeam(actor: CurrentUser, leadVaId: string, toModelId: string, opts: { allowShort?: boolean } = {}): Promise<Result<MoveOutcome>> {
  const movedVas: { vaId: string; account: string | null }[] = [];
  const freed = new Set<string>();
  try {
    const out = await db.$transaction(async (tx) => {
      const lva = await lockUser(tx, leadVaId);
      if (!lva || lva.status !== "ACTIVE" || !(await canMoveTeam(actor, lva))) throw new Abort("Team not found.");
      const to = await tx.model.findFirst({ where: { id: toModelId, active: true }, select: { id: true, name: true } });
      if (!to) throw new Abort("Pick an active model.");
      if (lva.modelId === to.id) throw new Abort(`This team already works for ${to.name}.`);

      const vas = await tx.user.findMany({ where: { parentId: lva.id, role: "VA", status: "ACTIVE" }, orderBy: { createdAt: "asc" }, select: { id: true } });
      const available = await claimableIn(tx, to.id);
      if (vas.length > available && !opts.allowShort) {
        throw new Abort(`${to.name} has ${available} free account${available === 1 ? "" : "s"} for ${vas.length} VAs: ${vas.length - available} short. Confirm to move anyway.`);
      }

      for (const v of vas) {
        const m = await moveVaToModel(tx, v.id, to.id);
        if (m.freedModel) freed.add(m.freedModel);
        movedVas.push({ vaId: v.id, account: m.account });
      }
      await tx.user.update({ where: { id: lva.id }, data: { modelId: to.id } });
      const needAccount = movedVas.filter((m) => !m.account).length;
      await audit(tx, {
        actorId: actor.id,
        action: "team.move",
        target: lva.id,
        meta: { from: lva.modelId, to: to.id, vas: vas.length, needAccount },
      });
      return { teams: 1, vas: vas.length, withAccount: vas.length - needAccount, needAccount };
    });
    for (const m of movedVas) await notifyAccountChange(m.vaId, "moved");
    for (const model of freed) await refillWaitingVas(model);
    return { ok: true, data: out };
  } catch (e) {
    if (e instanceof Abort) return fail(e.message);
    throw e;
  }
}

/** Director: move every team of model A to model B (each team in its own transaction). */
export async function bulkMoveTeams(actor: CurrentUser, fromModelId: string, toModelId: string, opts: { allowShort?: boolean } = {}): Promise<Result<MoveOutcome>> {
  const p = await planBulkMove(actor, fromModelId, toModelId);
  if (!p.ok) return p;
  if (p.data.short > 0 && !opts.allowShort) return fail(`${p.data.short} VAs would be left without an account. Confirm to move anyway.`);
  const total: MoveOutcome = { teams: 0, vas: 0, withAccount: 0, needAccount: 0 };
  for (const t of p.data.teams) {
    const r = await moveTeam(actor, t.id, toModelId, { allowShort: true });
    if (!r.ok) return fail(`Stopped at ${t.username}: ${r.error} (${total.teams} team${total.teams === 1 ? "" : "s"} already moved.)`);
    total.teams += r.data.teams;
    total.vas += r.data.vas;
    total.withAccount += r.data.withAccount;
    total.needAccount += r.data.needAccount;
  }
  return { ok: true, data: total };
}

// ── Fire inactive VAs ────────────────────────────────────────────────────

export type InactiveVa = { id: string; username: string; leadVa: string | null; since: Date; lastQualifiedAt: Date | null };

/**
 * Active VAs with no qualified convo in the last `days` days. VAs hired (or re-hired) within that window
 * are left out: they haven't had the chance yet. Director: everyone; Lead VA: their own team.
 */
export async function findInactiveVas(actor: CurrentUser, days: number, now = new Date()): Promise<Result<InactiveVa[]>> {
  if (actor.role !== "DIRECTOR" && actor.role !== "LEAD_VA") return fail("Not allowed.");
  if (!Number.isInteger(days) || days < 1 || days > 365) return fail("Pick a number of days between 1 and 365.");
  const cutoff = new Date(now.getTime() - days * 86400_000);
  const vas = await db.user.findMany({
    where: { role: "VA", status: "ACTIVE", createdAt: { lte: cutoff }, ...(actor.role === "LEAD_VA" ? { parentId: actor.id } : {}) },
    orderBy: { username: "asc" },
    select: { id: true, username: true, createdAt: true, parent: { select: { username: true } } },
  });
  const ids = vas.map((v) => v.id);
  const [recent, rehired, last] = await Promise.all([
    db.convo.groupBy({ by: ["vaId"], where: { vaId: { in: ids }, status: "QUALIFIED", qualifiedAt: { gte: cutoff } }, _count: true }),
    db.auditLog.findMany({ where: { action: "va.rehire", target: { in: ids }, createdAt: { gt: cutoff } }, select: { target: true } }),
    db.convo.groupBy({ by: ["vaId"], where: { vaId: { in: ids }, status: "QUALIFIED" }, _max: { qualifiedAt: true } }),
  ]);
  const active = new Set(recent.map((r) => r.vaId));
  const fresh = new Set(rehired.map((r) => r.target));
  const lastBy = new Map(last.map((l) => [l.vaId, l._max.qualifiedAt]));
  return {
    ok: true,
    data: vas
      .filter((v) => !active.has(v.id) && !fresh.has(v.id))
      .map((v) => ({ id: v.id, username: v.username, leadVa: v.parent?.username ?? null, since: v.createdAt, lastQualifiedAt: lastBy.get(v.id) ?? null })),
  };
}

/** Fires the confirmed VAs that are still inactive (anyone who qualified a convo since the preview is skipped). */
export async function fireInactiveVas(actor: CurrentUser, days: number, vaIds: string[]): Promise<Result<{ fired: number; skipped: number }>> {
  const list = await findInactiveVas(actor, days);
  if (!list.ok) return list;
  const still = new Set(list.data.map((v) => v.id));
  let fired = 0;
  let skipped = 0;
  for (const id of vaIds) {
    if (!still.has(id)) {
      skipped++;
      continue;
    }
    const r = await fireUser(actor, id);
    if (r.ok) fired++;
    else skipped++;
  }
  return { ok: true, data: { fired, skipped } };
}
