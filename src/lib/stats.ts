// The stats layer (PLAN.md §8, Block 7). Every dashboard number comes from here, and every
// query here is filtered through scopeFor(user). Pages never aggregate convos themselves.
import type { Prisma, TgStatus } from "@prisma/client";
import { db } from "@/lib/db";
import { scopeFor, type ScopeUser } from "@/lib/scope";
import { getSetting } from "@/lib/settings";
import { dayBounds, weekBounds } from "@/lib/weeks";

export type Totals = { convos: number; vaCents: number; leadVaCents: number; lmCents: number };
export const ZERO: Totals = { convos: 0, vaCents: 0, leadVaCents: 0, lmCents: 0 };

export type Period = { startsAt: Date; endsAt: Date };

/** The current pay week and today, in the org timezone. */
export async function currentPeriods(now = new Date()) {
  const tz = await getSetting("timezone");
  return { timeZone: tz, week: weekBounds(now, tz), today: dayBounds(now, tz) };
}

/** Qualified convos in the pay week that starts at `week.startsAt` (works before the Week row exists). */
export const inWeek = (week: Period): Prisma.ConvoWhereInput => ({ week: { startsAt: week.startsAt } });
export const qualifiedBetween = (p: Period): Prisma.ConvoWhereInput => ({ qualifiedAt: { gte: p.startsAt, lt: p.endsAt } });

function where(user: ScopeUser, extra: Prisma.ConvoWhereInput): Prisma.ConvoWhereInput {
  return { AND: [scopeFor(user).convo, { status: "QUALIFIED" }, extra] };
}

export async function qualifiedTotals(user: ScopeUser, extra: Prisma.ConvoWhereInput = {}): Promise<Totals> {
  const agg = await db.convo.aggregate({
    where: where(user, extra),
    _count: true,
    _sum: { vaCents: true, leadVaCents: true, lmCents: true },
  });
  return {
    convos: agg._count,
    vaCents: agg._sum.vaCents ?? 0,
    leadVaCents: agg._sum.leadVaCents ?? 0,
    lmCents: agg._sum.lmCents ?? 0,
  };
}

type GroupField = "vaId" | "leadVaId" | "leadManagerId" | "tgAccountId";

/** Qualified totals grouped by a snapshotted attribution field, within the user's scope. */
export async function qualifiedTotalsBy(
  user: ScopeUser,
  field: GroupField,
  extra: Prisma.ConvoWhereInput = {},
): Promise<Map<string, Totals>> {
  const rows = await db.convo.groupBy({
    by: [field],
    where: where(user, extra),
    _count: true,
    _sum: { vaCents: true, leadVaCents: true, lmCents: true },
  });
  const out = new Map<string, Totals>();
  for (const r of rows) {
    const key = r[field];
    if (!key) continue;
    out.set(key, { convos: r._count, vaCents: r._sum.vaCents ?? 0, leadVaCents: r._sum.leadVaCents ?? 0, lmCents: r._sum.lmCents ?? 0 });
  }
  return out;
}

export async function reviewCount(user: ScopeUser): Promise<number> {
  return db.convo.count({ where: { AND: [scopeFor(user).convo, { status: "REVIEW" }] } });
}

export type PoolHealth = { modelId: string; name: string; active: boolean; counts: Record<TgStatus, number> };

/** Account counts per model for the accounts the user may see. */
export async function poolHealth(user: ScopeUser): Promise<PoolHealth[]> {
  const [models, groups] = await Promise.all([
    db.model.findMany({ orderBy: { name: "asc" }, select: { id: true, name: true, active: true } }),
    db.tgAccount.groupBy({ by: ["modelId", "status"], where: scopeFor(user).tgAccount, _count: true }),
  ]);
  const seen = new Set(groups.map((g) => g.modelId));
  return models
    .filter((m) => user.role === "DIRECTOR" || seen.has(m.id) || m.id === user.modelId)
    .map((m) => {
      const counts = { AVAILABLE: 0, ASSIGNED: 0, BANNED: 0, RETIRED: 0 } as Record<TgStatus, number>;
      for (const g of groups) if (g.modelId === m.id) counts[g.status] = g._count;
      return { modelId: m.id, name: m.name, active: m.active, counts };
    });
}

export async function activeVaCount(user: ScopeUser): Promise<number> {
  return db.user.count({ where: { AND: [scopeFor(user).user, { role: "VA", status: "ACTIVE" }] } });
}

export const sumTotals = (list: Iterable<Totals>): Totals => {
  const t = { ...ZERO };
  for (const x of list) {
    t.convos += x.convos;
    t.vaCents += x.vaCents;
    t.leadVaCents += x.leadVaCents;
    t.lmCents += x.lmCents;
  }
  return t;
};
