import { beforeEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { liveBoard, pastWinners } from "@/lib/leaderboard";
import { lockFinishedWeeks, lockWeek } from "@/lib/payouts";
import { currentPeriods, inWeek, qualifiedTotals } from "@/lib/stats";
import { weekBounds } from "@/lib/weeks";
import { asActor, makeModel, makeUser, resetDb, setSetting } from "../../test/fixtures";

const TZ = "Etc/GMT-2";
const thisWeek = () => weekBounds(new Date(), TZ);
const lastWeek = () => weekBounds(new Date(thisWeek().startsAt.getTime() - 1), TZ);

let peer = 0;
/** `n` qualified convos for a VA, qualified at `start`, start+1min, … inside the given week. */
async function convos(va: { id: string; parentId: string | null }, n: number, week: { id: string; startsAt: Date }, startMin = 60) {
  const lva = await db.user.findUniqueOrThrow({ where: { id: va.parentId! }, select: { id: true, parentId: true } });
  for (let i = 0; i < n; i++) {
    const qualifiedAt = new Date(week.startsAt.getTime() + (startMin + i) * 60_000);
    await db.convo.create({
      data: {
        accountRef: "acct",
        peerId: `p${++peer}`,
        firstMsgAt: qualifiedAt,
        repliedAt: qualifiedAt,
        qualifiedAt,
        status: "QUALIFIED",
        vaId: va.id,
        leadVaId: lva.id,
        leadManagerId: lva.parentId,
        weekId: week.id,
        vaCents: 25,
        leadVaCents: 10,
        lmCents: 0,
      },
    });
  }
}

/** Director → LM → `teams` Lead VAs, each with `vasPer` VAs. */
async function org(teams: number, vasPer: number) {
  const model = await makeModel();
  const director = await makeUser("DIRECTOR", null);
  const lm = await makeUser("LEAD_MANAGER", director.id);
  const lvas = [];
  for (let t = 0; t < teams; t++) {
    const lva = await makeUser("LEAD_VA", lm.id, model.id);
    const vas = [];
    for (let v = 0; v < vasPer; v++) vas.push(await makeUser("VA", lva.id, model.id));
    lvas.push({ lva, vas });
  }
  return { director, lm, lvas };
}

beforeEach(async () => {
  await resetDb();
  peer = 0;
});

describe("live leaderboard", () => {
  it("ranks VAs agency-wide on this week's qualified convos; counts match the earnings stat cards", async () => {
    const o = await org(2, 2);
    const week = await db.week.create({ data: thisWeek() });
    const [a, b] = o.lvas[0].vas;
    const [c, d] = o.lvas[1].vas;
    await convos(a, 2, week);
    await convos(b, 5, week);
    await convos(c, 3, week);
    // a REVIEW convo and a convo from another week don't count
    await db.convo.create({ data: { accountRef: "acct", peerId: "rev", firstMsgAt: new Date(), status: "REVIEW", vaId: d.id, weekId: week.id } });
    const old = await db.week.create({ data: lastWeek() });
    await convos(d, 9, old);

    const { week: period } = await currentPeriods();
    const board = await liveBoard("VA", period);
    expect(board.map((r) => [r.rank, r.userId, r.convos, r.cents])).toEqual([
      [1, b.id, 5, 125],
      [2, c.id, 3, 75],
      [3, a.id, 2, 50],
      [4, d.id, 0, 0],
    ]);
    for (const r of board) {
      const own = await qualifiedTotals(asActor({ id: r.userId, role: "VA", modelId: null }), inWeek(period));
      expect(own.convos).toBe(r.convos);
      expect(own.vaCents).toBe(r.cents);
    }
  });

  it("Lead VA board: team totals; fired and disabled users are left off", async () => {
    const o = await org(3, 2);
    const week = await db.week.create({ data: thisWeek() });
    await convos(o.lvas[0].vas[0], 2, week);
    await convos(o.lvas[0].vas[1], 2, week); // team 0: 4
    await convos(o.lvas[1].vas[0], 6, week); // team 1: 6
    await convos(o.lvas[2].vas[0], 9, week); // team 2: 9, but its Lead VA is fired
    await db.user.update({ where: { id: o.lvas[2].lva.id }, data: { status: "FIRED" } });
    await db.user.update({ where: { id: o.lvas[1].vas[0].id }, data: { status: "DISABLED" } });

    const { week: period } = await currentPeriods();
    const lva = await liveBoard("LEAD_VA", period);
    expect(lva.map((r) => [r.userId, r.convos, r.cents])).toEqual([
      [o.lvas[1].lva.id, 6, 60], // the disabled VA's convos still count for the team (they're paid on them)
      [o.lvas[0].lva.id, 4, 40],
    ]);
    const va = await liveBoard("VA", period);
    expect(va.map((r) => r.userId)).not.toContain(o.lvas[1].vas[0].id);
  });

  it("ties: whoever reached the count first ranks higher", async () => {
    const o = await org(1, 2);
    const week = await db.week.create({ data: thisWeek() });
    const [slow, fast] = o.lvas[0].vas;
    await convos(slow, 3, week, 100); // 3rd convo at +102 min
    await convos(fast, 3, week, 10); // 3rd convo at +12 min
    const board = await liveBoard("VA", (await currentPeriods()).week);
    expect(board.map((r) => r.userId)).toEqual([fast.id, slow.id]);
  });
});

describe("prizes at week lock", () => {
  it("top 3 of each board get their prize as a separate bonus on their payout, exactly once", async () => {
    await setSetting("leaderboardPrizes", { va: [1000, 800, 500], leadVa: [3000, 1000, 500] });
    const o = await org(2, 3);
    const week = await db.week.create({ data: lastWeek() });
    const [v1, v2, v3] = o.lvas[0].vas;
    const [v4] = o.lvas[1].vas;
    await convos(v1, 6, week);
    await convos(v2, 4, week);
    await convos(v3, 1, week);
    await convos(v4, 2, week);

    const r = await lockWeek(o.director.id, week.id);
    expect(r.ok).toBe(true);
    const pay = async (userId: string) => db.payout.findUniqueOrThrow({ where: { userId_weekId: { userId, weekId: week.id } } });
    expect(await pay(v1.id)).toMatchObject({ convos: 6, bonusCents: 1000, amountCents: 6 * 25 + 1000 });
    expect(await pay(v2.id)).toMatchObject({ convos: 4, bonusCents: 800, amountCents: 4 * 25 + 800 });
    expect(await pay(v4.id)).toMatchObject({ convos: 2, bonusCents: 500, amountCents: 2 * 25 + 500 });
    expect(await pay(v3.id)).toMatchObject({ convos: 1, bonusCents: 0, amountCents: 25 });
    // Lead VAs: team 0 has 11, team 1 has 2; only two teams, so no 3rd prize
    expect(await pay(o.lvas[0].lva.id)).toMatchObject({ convos: 11, bonusCents: 3000, amountCents: 110 + 3000 });
    expect(await pay(o.lvas[1].lva.id)).toMatchObject({ convos: 2, bonusCents: 1000, amountCents: 20 + 1000 });
    if (r.ok) expect(r.data.totalCents).toBe(13 * 25 + 13 * 10 + 1000 + 800 + 500 + 3000 + 1000);

    // Locking again (cron + button, or a retry) adds nothing.
    const again = await lockWeek(o.director.id, week.id);
    expect(again.ok && again.data.alreadyLocked).toBe(true);
    await lockFinishedWeeks(null);
    expect((await db.payout.aggregate({ where: { weekId: week.id }, _sum: { bonusCents: true } }))._sum.bonusCents).toBe(6300);
    expect(await db.leaderboardWin.count({ where: { weekId: week.id } })).toBe(5);

    // Winners are frozen: later changes to prizes or people don't rewrite them.
    await setSetting("leaderboardPrizes", { va: [5, 5, 5], leadVa: [5, 5, 5] });
    await db.user.update({ where: { id: v1.id }, data: { status: "FIRED" } });
    const [past] = await pastWinners();
    expect(past.leaderboardWins.filter((w) => w.board === "VA").map((w) => [w.rank, w.user.username, w.convos, w.prizeCents])).toEqual([
      [1, v1.username, 6, 1000],
      [2, v2.username, 4, 800],
      [3, v4.username, 2, 500],
    ]);
  });

  it("someone fired before the lock gets no prize; the next person moves up", async () => {
    const o = await org(1, 3);
    const week = await db.week.create({ data: lastWeek() });
    const [top, second, third] = o.lvas[0].vas;
    await convos(top, 5, week);
    await convos(second, 3, week);
    await convos(third, 1, week);
    await db.user.update({ where: { id: top.id }, data: { status: "FIRED" } });

    await lockWeek(null, week.id);
    const wins = await db.leaderboardWin.findMany({ where: { weekId: week.id, board: "VA" }, orderBy: { rank: "asc" } });
    expect(wins.map((w) => [w.rank, w.userId])).toEqual([
      [1, second.id],
      [2, third.id],
    ]);
    // they still get paid for the convos they earned, just no prize
    expect(await db.payout.findFirstOrThrow({ where: { userId: top.id } })).toMatchObject({ amountCents: 125, bonusCents: 0 });
  });

  it("a winner with no commission line (zero rate) still gets a payout for the prize", async () => {
    const o = await org(1, 1);
    const week = await db.week.create({ data: lastWeek() });
    await convos(o.lvas[0].vas[0], 2, week);
    await db.convo.updateMany({ data: { leadVaCents: 0 } });
    await lockWeek(null, week.id);
    expect(await db.payout.findFirstOrThrow({ where: { userId: o.lvas[0].lva.id } })).toMatchObject({
      role: "LEAD_VA",
      convos: 2,
      amountCents: 3000,
      bonusCents: 3000,
    });
  });

  it("a week with no convos has no winners", async () => {
    await org(1, 2);
    const week = await db.week.create({ data: lastWeek() });
    await lockWeek(null, week.id);
    expect(await db.leaderboardWin.count()).toBe(0);
    expect(await pastWinners()).toEqual([]);
  });
});
