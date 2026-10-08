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

type GroupField = "vaId" | "leadVaId" | "leadManagerId" | "tgAccountId" | "weekId";

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

// ── Commission (Lead VA / Lead Manager payouts pages) ─────────────────────

const COMMISSION_FIELD = { VA: "vaCents", LEAD_VA: "leadVaCents", LEAD_MANAGER: "lmCents" } as const;

export type CommissionSummary = {
  currentCents: number; // this week, not paid yet
  currentConvos: number;
  paidToDateCents: number;
  totalConvos: number; // all-time qualified convos they earned on
  weeklyAverageCents: number; // over completed weeks with earnings
  bestWeek: { startsAt: Date; endsAt: Date; cents: number } | null;
  history: { id: string; startsAt: Date; endsAt: Date; convos: number; amountCents: number; status: string; paidAt: Date | null }[];
};

/** The user's own commission. Only their own payouts and their own commission column count. */
export async function commissionSummary(user: ScopeUser & { role: "VA" | "LEAD_VA" | "LEAD_MANAGER" }, week: Period): Promise<CommissionSummary> {
  const field = COMMISSION_FIELD[user.role];
  const [current, all, byWeek, payouts] = await Promise.all([
    qualifiedTotals(user, inWeek(week)),
    qualifiedTotals(user),
    qualifiedTotalsBy(user, "weekId"),
    db.payout.findMany({
      where: { AND: [scopeFor(user).payout, { userId: user.id }] },
      orderBy: { week: { startsAt: "desc" } },
      take: 26,
      select: { id: true, convos: true, amountCents: true, status: true, paidAt: true, week: { select: { startsAt: true, endsAt: true } } },
    }),
  ]);
  // Average and best week are over completed weeks only; the current week is still filling up.
  const weeks = await db.week.findMany({
    where: { id: { in: [...byWeek.keys()] }, startsAt: { lt: week.startsAt } },
    select: { id: true, startsAt: true, endsAt: true },
  });
  const earned = weeks.map((w) => ({ ...w, cents: byWeek.get(w.id)![field] })).filter((w) => w.cents > 0);
  const best = earned.reduce<(typeof earned)[number] | null>((b, w) => (!b || w.cents > b.cents ? w : b), null);
  const paid = await db.payout.aggregate({ where: { userId: user.id, status: "SENT" }, _sum: { amountCents: true } });

  return {
    currentCents: current[field],
    currentConvos: current.convos,
    paidToDateCents: paid._sum.amountCents ?? 0,
    totalConvos: all.convos,
    weeklyAverageCents: earned.length ? Math.round(earned.reduce((s, w) => s + w.cents, 0) / earned.length) : 0,
    bestWeek: best ? { startsAt: best.startsAt, endsAt: best.endsAt, cents: best.cents } : null,
    history: payouts.map((p) => ({ id: p.id, ...p.week, convos: p.convos, amountCents: p.amountCents, status: p.status, paidAt: p.paidAt })),
  };
}
