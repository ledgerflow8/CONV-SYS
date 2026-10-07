// The dashboard numbers (stats layer) must agree across levels and never leak across scopes.
import { beforeAll, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { ingestConvoEvent } from "@/lib/ingest";
import { currentPeriods, inWeek, poolHealth, qualifiedTotals, qualifiedTotalsBy, reviewCount, sumTotals, activeVaCount } from "@/lib/stats";
import { weekBounds } from "@/lib/weeks";
import { resetDb } from "../../test/fixtures";
import { buildOrg, events, rng, type Org } from "../../test/scenario";

let org: Org;
let week: { startsAt: Date; endsAt: Date };

beforeAll(async () => {
  await resetDb();
  org = await buildOrg();
  week = (await currentPeriods()).week;
  const lastWeekStart = weekBounds(new Date(week.startsAt.getTime() - 1), "Etc/GMT-2").startsAt;
  for (const e of events(org, 300, rng(99), { from: lastWeekStart.getTime(), to: Date.now() })) {
    await ingestConvoEvent(e, { via: "api" });
  }
});

describe("stats layer", () => {
  it("has data in both weeks, so the week filter is actually exercised", async () => {
    const thisWeek = await qualifiedTotals(org.director, inWeek(week));
    const all = await qualifiedTotals(org.director);
    expect(thisWeek.convos).toBeGreaterThan(0);
    expect(all.convos).toBeGreaterThan(thisWeek.convos);
  });

  it("Lead VA: per-VA breakdown sums to the team cards", async () => {
    for (const lva of org.lvas) {
      const team = await qualifiedTotals(lva, inWeek(week));
      const byVa = await qualifiedTotalsBy(lva, "vaId", inWeek(week));
      expect(sumTotals(byVa.values())).toEqual(team);
      // each VA's own dashboard matches their row on the Lead VA's list
      for (const va of org.vas.filter((v) => v.parentId === lva.id)) {
        expect(await qualifiedTotals(va, inWeek(week))).toEqual(byVa.get(va.id) ?? { convos: 0, vaCents: 0, leadVaCents: 0, lmCents: 0 });
      }
    }
  });

  it("Lead Manager: per-team breakdown sums to the LM cards, and each team matches its Lead VA's own view", async () => {
    for (const lm of org.lms) {
      const all = await qualifiedTotals(lm, inWeek(week));
      const byTeam = await qualifiedTotalsBy(lm, "leadVaId", inWeek(week));
      expect(sumTotals(byTeam.values())).toEqual(all);
      for (const lva of org.lvas.filter((l) => l.parentId === lm.id)) {
        expect(byTeam.get(lva.id)).toEqual(await qualifiedTotals(lva, inWeek(week)));
      }
    }
  });

  it("Director: per-LM breakdown sums to the org cards", async () => {
    const all = await qualifiedTotals(org.director, inWeek(week));
    const byLm = await qualifiedTotalsBy(org.director, "leadManagerId", inWeek(week));
    expect(sumTotals(byLm.values())).toEqual(all);
  });

  it("scopes never leak: a VA can't see another VA's convos, nor an LM another LM's teams", async () => {
    const [vaA, vaB] = org.vas;
    const aKeys = [...(await qualifiedTotalsBy(vaA, "vaId")).keys()];
    expect(aKeys.every((k) => k === vaA.id)).toBe(true);
    expect((await qualifiedTotalsBy(vaA, "vaId")).has(vaB.id)).toBe(false);

    const [lmA, lmB] = org.lms;
    const teamsSeenByA = [...(await qualifiedTotalsBy(lmA, "leadVaId")).keys()];
    const lmBTeams = org.lvas.filter((l) => l.parentId === lmB.id).map((l) => l.id);
    expect(teamsSeenByA.some((t) => lmBTeams.includes(t))).toBe(false);

    expect(await reviewCount(vaA)).toBe(await db.convo.count({ where: { vaId: vaA.id, status: "REVIEW" } }));
  });

  it("pool health and active VAs are scoped", async () => {
    const lva = org.lvas[0];
    const lvaPool = await poolHealth(lva);
    expect(lvaPool.map((p) => p.modelId)).toEqual([lva.modelId]);
    expect(lvaPool[0].counts.ASSIGNED).toBe(org.vas.filter((v) => v.parentId === lva.id).length); // only their team's

    const directorPool = await poolHealth(org.director);
    expect(directorPool.reduce((n, p) => n + p.counts.ASSIGNED, 0)).toBe(org.vas.length);

    expect(await activeVaCount(org.director)).toBe(org.vas.length);
    expect(await activeVaCount(org.lms[0])).toBe(org.vas.filter((v) => org.lvas.find((l) => l.id === v.parentId)?.parentId === org.lms[0].id).length);
    expect(await activeVaCount(org.vas[0])).toBe(1);
  });
});
