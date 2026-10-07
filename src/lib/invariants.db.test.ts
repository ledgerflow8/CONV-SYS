// PLAN.md §4 invariants, checked on a randomised but reproducible org and event stream.
// Totals are computed through scopeFor(), the same filter the dashboards use.
import { beforeAll, describe, expect, it } from "vitest";
import type { Prisma, Role } from "@prisma/client";
import { db } from "@/lib/db";
import { ingestConvoEvent } from "@/lib/ingest";
import { scopeFor } from "@/lib/scope";
import { weekBounds } from "@/lib/weeks";
import { assign, makeAccount, makeModel, makeUser, resetDb } from "../../test/fixtures";

const TZ = "Etc/GMT-2";
const DAY = 24 * 3600_000;

// Deterministic PRNG so a failure is reproducible.
function rng(seed: number) {
  return () => {
    seed = (seed * 1664525 + 1013904223) % 2 ** 32;
    return seed / 2 ** 32;
  };
}

type Person = { id: string; role: Role; modelId: string | null; parentId: string | null };
type Org = { director: Person; lms: Person[]; lvas: Person[]; vas: Person[]; accounts: { id: string; username: string; vaId: string }[] };

async function buildOrg(): Promise<Org> {
  const models = [await makeModel(), await makeModel()];
  const director = await makeUser("DIRECTOR", null);
  const org: Org = { director, lms: [], lvas: [], vas: [], accounts: [] };
  for (let l = 0; l < 2; l++) {
    const lm = await makeUser("LEAD_MANAGER", director.id);
    org.lms.push(lm);
    for (let t = 0; t < 2; t++) {
      const model = models[t];
      const lva = await makeUser("LEAD_VA", lm.id, model.id);
      org.lvas.push(lva);
      for (let v = 0; v < 3; v++) {
        const va = await makeUser("VA", lva.id, model.id);
        org.vas.push(va);
        const acct = await makeAccount(model.id);
        await assign(acct.id, va.id, new Date(Date.now() - 30 * DAY));
        org.accounts.push({ id: acct.id, username: acct.username, vaId: va.id });
      }
    }
  }
  return org;
}

const PHONES = ["+14155550100", "+16475550100", "+447400123456", "+61412345678", "+353851234567", "+2348031234567", "+919812345678", null, null];

function events(org: Org, count: number, rand: () => number, window: { from: number; to: number }) {
  const out: Record<string, unknown>[] = [];
  for (let i = 0; i < count; i++) {
    const acct = org.accounts[Math.floor(rand() * org.accounts.length)];
    const first = window.from + rand() * (window.to - window.from - 3600_000);
    const replied = rand() < 0.8 ? first + rand() * 3000_000 : null;
    const e = {
      tgAccount: acct.username,
      peerId: `peer${Math.floor(rand() * count * 0.7)}`, // ~30% collide → repeat events
      peerPhone: PHONES[Math.floor(rand() * PHONES.length)],
      firstMsgAt: new Date(first).toISOString(),
      ...(replied ? { repliedAt: new Date(Math.min(replied, Date.now() - 1000)).toISOString() } : {}),
    };
    out.push(e);
    if (rand() < 0.2) out.push({ ...e }); // exact duplicate delivery
  }
  // shuffle: events don't arrive in order
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

async function totals(user: Person, extra: Prisma.ConvoWhereInput = {}) {
  const where = { AND: [scopeFor(user).convo, { status: "QUALIFIED" as const }, extra] };
  const agg = await db.convo.aggregate({ where, _count: true, _sum: { vaCents: true, leadVaCents: true, lmCents: true } });
  return { convos: agg._count, vaCents: agg._sum.vaCents ?? 0, leadVaCents: agg._sum.leadVaCents ?? 0, lmCents: agg._sum.lmCents ?? 0 };
}

const add = (a: Awaited<ReturnType<typeof totals>>, b: Awaited<ReturnType<typeof totals>>) => ({
  convos: a.convos + b.convos,
  vaCents: a.vaCents + b.vaCents,
  leadVaCents: a.leadVaCents + b.leadVaCents,
  lmCents: a.lmCents + b.lmCents,
});
const zero = { convos: 0, vaCents: 0, leadVaCents: 0, lmCents: 0 };

let org: Org;
const thisWeek = weekBounds(new Date(), TZ);
const lastWeek = weekBounds(new Date(thisWeek.startsAt.getTime() - 1), TZ);

describe("invariants", () => {
  beforeAll(async () => {
    await resetDb();
    await db.setting.update({ where: { key: "rates" }, data: { value: { va: 25, leadVa: 10, lm: 3 } } });
    org = await buildOrg();
    const rand = rng(42);
    const evs = events(org, 400, rand, { from: lastWeek.startsAt.getTime(), to: Date.now() });
    for (const e of evs) {
      const r = await ingestConvoEvent(e, { via: "api" });
      if (!r.ok) throw new Error(`event rejected: ${r.error} ${JSON.stringify(e)}`);
    }
  });

  it("the stream produced a meaningful mix", async () => {
    const byStatus = await db.convo.groupBy({ by: ["status"], _count: true });
    const n = Object.fromEntries(byStatus.map((s) => [s.status, s._count]));
    expect(n.QUALIFIED).toBeGreaterThan(50);
    expect(n.REJECTED).toBeGreaterThan(10);
    expect((n.PENDING ?? 0) + (n.REVIEW ?? 0)).toBeGreaterThan(10);
  });

  // Sums use real team membership (who reports to whom) and each person's own scoped
  // total, so a convo snapshotted onto the wrong Lead VA / Lead Manager breaks them.
  // Nobody changes teams in this fixture, so membership and snapshots must agree.

  it("sum of VA earnings in a team = team total on the Lead VA dashboard", async () => {
    for (const lva of org.lvas) {
      const team = await totals(lva);
      let sum = zero;
      for (const va of org.vas.filter((v) => v.parentId === lva.id)) sum = add(sum, await totals(va));
      expect(sum).toEqual(team);
      expect(team.convos).toBeGreaterThan(0);
      expect(team.leadVaCents).toBe(team.convos * 10);
    }
  });

  it("sum of team totals under a Lead Manager = Lead Manager total", async () => {
    for (const lm of org.lms) {
      const lmTotal = await totals(lm);
      let sum = zero;
      for (const lva of org.lvas.filter((l) => l.parentId === lm.id)) sum = add(sum, await totals(lva));
      expect(sum).toEqual(lmTotal);
      expect(lmTotal.lmCents).toBe(lmTotal.convos * 3);
    }
  });

  it("sum over all Lead Managers = Director total = sum over all VAs", async () => {
    let byLm = zero;
    for (const lm of org.lms) byLm = add(byLm, await totals(lm));
    let byVa = zero;
    for (const va of org.vas) byVa = add(byVa, await totals(va));
    const director = await totals(org.director);
    expect(byLm).toEqual(director);
    expect(byVa).toEqual(director);
  });

  it("a convo counts in exactly one week and exactly once", async () => {
    const qualified = await db.convo.findMany({ where: { status: "QUALIFIED" }, select: { accountRef: true, peerId: true, weekId: true, qualifiedAt: true } });
    expect(qualified.every((c) => c.weekId && c.qualifiedAt)).toBe(true);
    const keys = new Set(qualified.map((c) => `${c.accountRef}|${c.peerId}`));
    expect(keys.size).toBe(qualified.length);

    const perWeek = await db.convo.groupBy({ by: ["weekId"], where: { status: "QUALIFIED" }, _count: true });
    expect(perWeek.reduce((s, w) => s + w._count, 0)).toBe(qualified.length);
    expect(await db.convo.count({ where: { status: { not: "QUALIFIED" }, weekId: { not: null } } })).toBe(0);

    const qualifyAudits = await db.auditLog.groupBy({ by: ["target"], where: { action: "convo.status", meta: { path: ["to"], equals: "QUALIFIED" } }, _count: true });
    expect(qualifyAudits.every((a) => a._count === 1)).toBe(true);
    expect(qualifyAudits.length).toBe(qualified.length);
  });

  it("a locked week never changes; late events go to the open week, flagged late", async () => {
    const week = await db.week.findUniqueOrThrow({ where: { startsAt: lastWeek.startsAt } });
    await db.week.update({ where: { id: week.id }, data: { status: "LOCKED" } });
    const snapshot = async () =>
      db.convo.findMany({ where: { weekId: week.id }, orderBy: { id: "asc" } });
    const before = await snapshot();
    expect(before.length).toBeGreaterThan(0);

    // Fresh events whose replies fall in the locked week, plus a re-delivery of the original stream.
    const rand = rng(7);
    const lateEvents = events(org, 120, rand, { from: lastWeek.startsAt.getTime(), to: lastWeek.endsAt.getTime() }).map((e) => ({
      ...e,
      peerId: `late-${e.peerId}`,
    }));
    const original = events(org, 400, rng(42), { from: lastWeek.startsAt.getTime(), to: Date.now() });
    for (const e of [...lateEvents, ...original]) await ingestConvoEvent(e, { via: "api" });

    expect(await snapshot()).toEqual(before);
    const lateQualified = await db.convo.findMany({ where: { peerId: { startsWith: "late-" }, status: "QUALIFIED" }, include: { week: true } });
    expect(lateQualified.length).toBeGreaterThan(0);
    for (const c of lateQualified) {
      expect(c.week?.startsAt.toISOString()).toBe(thisWeek.startsAt.toISOString());
      expect(await db.auditLog.count({ where: { action: "convo.late", target: c.id } })).toBe(1);
    }
  });
});
