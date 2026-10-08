import { beforeEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { ingestConvoEvent, lockedWeekFor } from "@/lib/ingest";
import { lockFinishedWeeks, lockWeek, markPayoutFailed, markPayoutPaid, refreshPayoutWallet, setWallet } from "@/lib/payouts";
import { weekBounds } from "@/lib/weeks";
import { asActor, makeAccount, makeTeam, makeUser, assign, resetDb, setSetting } from "../../test/fixtures";

const TZ = "Etc/GMT-2";
const W1 = "0x52908400098527886E0F7030069857D2E4169EE7";
const W2 = "0x8617E340B3D01FA5F11F306F4090FD50E238070D";
const HASH = "ab".repeat(32);

const thisWeek = () => weekBounds(new Date(), TZ);
const lastWeek = () => weekBounds(new Date(thisWeek().startsAt.getTime() - 1), TZ);

/** A qualified convo replied in last week. */
async function qualifyLastWeek(accountUsername: string, peerId: string, offsetMin = 0) {
  const replied = new Date(lastWeek().startsAt.getTime() + 2 * 24 * 3600_000 + offsetMin * 60_000);
  const r = await ingestConvoEvent(
    { tgAccount: accountUsername, peerId, peerPhone: "+14155550100", firstMsgAt: new Date(replied.getTime() - 60_000).toISOString(), repliedAt: replied.toISOString() },
    { via: "api" },
  );
  if (!r.ok || r.data.status !== "QUALIFIED") throw new Error(`setup convo not qualified: ${JSON.stringify(r)}`);
  return r.data;
}

async function lastWeekRow() {
  return db.week.findUniqueOrThrow({ where: { startsAt: lastWeek().startsAt } });
}

beforeEach(async () => {
  await resetDb();
  await setSetting("rates", { va: 25, leadVa: 10, lm: 5 });
});

describe("lockWeek", () => {
  it("creates one payout per earner per role, matching the week's convo sums, with wallet snapshots", async () => {
    const t = await makeTeam();
    await db.user.update({ where: { id: t.va.id }, data: { walletAddress: W1 } });
    for (let i = 0; i < 4; i++) await qualifyLastWeek(t.account.username, `p${i}`, i);
    const week = await lastWeekRow();

    const r = await lockWeek(t.director.id, week.id);
    expect(r.ok && r.data).toMatchObject({ payouts: 3, totalCents: 4 * (25 + 10 + 5), alreadyLocked: false });
    const payouts = await db.payout.findMany({ where: { weekId: week.id } });
    const by = Object.fromEntries(payouts.map((p) => [p.role, p]));
    expect(by.VA).toMatchObject({ userId: t.va.id, convos: 4, amountCents: 100, walletAddress: W1, status: "PENDING" });
    expect(by.LEAD_VA).toMatchObject({ userId: t.lva.id, convos: 4, amountCents: 40, walletAddress: null });
    expect(by.LEAD_MANAGER).toMatchObject({ userId: t.lm.id, convos: 4, amountCents: 20 });
    expect((await lastWeekRow()).status).toBe("LOCKED");

    // wallet changes after the lock don't touch the snapshot
    await setWallet(asActor(t.va), W2);
    expect((await db.payout.findFirstOrThrow({ where: { userId: t.va.id } })).walletAddress).toBe(W1);
  });

  it("is idempotent and refuses a week that hasn't ended", async () => {
    const t = await makeTeam();
    await qualifyLastWeek(t.account.username, "p");
    const week = await lastWeekRow();
    await lockWeek(null, week.id);
    const again = await lockWeek(null, week.id);
    expect(again.ok && again.data.alreadyLocked).toBe(true);
    expect(await db.payout.count()).toBe(3);

    const current = await db.week.create({ data: thisWeek() });
    expect((await lockWeek(null, current.id)).ok).toBe(false);
  });

  it("zero-rate roles get no payout row", async () => {
    await setSetting("rates", { va: 25, leadVa: 10, lm: 0 });
    const t = await makeTeam();
    await qualifyLastWeek(t.account.username, "p");
    await lockWeek(null, (await lastWeekRow()).id);
    expect(await db.payout.count({ where: { role: "LEAD_MANAGER" } })).toBe(0);
  });

  it("lockFinishedWeeks catches up every finished open week, never the current one", async () => {
    const t = await makeTeam();
    await qualifyLastWeek(t.account.username, "p");
    const older = weekBounds(new Date(lastWeek().startsAt.getTime() - 1), TZ);
    await db.week.create({ data: older });
    await db.week.create({ data: thisWeek() });
    const results = await lockFinishedWeeks(null);
    expect(results.filter((r) => !r.alreadyLocked)).toHaveLength(2);
    expect((await db.week.findUniqueOrThrow({ where: { startsAt: thisWeek().startsAt } })).status).toBe("OPEN");
  });

  it("a lock waits for an in-flight ingest that already read the week, and pays its convo", async () => {
    const t = await makeTeam();
    await qualifyLastWeek(t.account.username, "first");
    const week = await lastWeekRow();
    let lockSettled = false;
    let lock: ReturnType<typeof lockWeek> | undefined;

    await db.$transaction(async (tx) => {
      // Exactly what ingest does before writing a qualified convo.
      const w = await lockedWeekFor(tx, new Date(week.startsAt.getTime() + 3600_000), TZ);
      expect(w.status).toBe("OPEN");
      lock = lockWeek(null, week.id);
      void lock.then(() => (lockSettled = true));
      await new Promise((r) => setTimeout(r, 500));
      expect(lockSettled).toBe(false); // blocked on our FOR SHARE
      const first = await tx.convo.findFirstOrThrow({ where: { peerId: "first" } });
      await tx.convo.create({
        data: { ...first, id: undefined, peerId: "in-flight", createdAt: undefined },
      });
    });

    const r = await lock!;
    expect(r.ok && r.data.payouts).toBe(3);
    const va = await db.payout.findFirstOrThrow({ where: { weekId: week.id, role: "VA" } });
    expect(va.convos).toBe(2); // the in-flight convo is included
  });

  it("smoke: many ingests racing a lock never leave a convo unpaid", async () => {
    const model = (await makeTeam()).model;
    const lva = await db.user.findFirstOrThrow({ where: { role: "LEAD_VA" } });
    // 10 VAs × 1 account each, so events don't contend on one VA row
    const accts: string[] = [];
    for (let i = 0; i < 10; i++) {
      const va = await makeUser("VA", lva.id, model.id);
      const a = await makeAccount(model.id);
      await assign(a.id, va.id, new Date(lastWeek().startsAt.getTime() - 3600_000));
      accts.push(a.username);
    }
    await qualifyLastWeek(accts[0], "seed"); // creates the Week row
    const week = await lastWeekRow();

    const ingests = Array.from({ length: 60 }, (_, i) => {
      const replied = new Date(lastWeek().startsAt.getTime() + 3 * 24 * 3600_000 + i * 1000);
      return ingestConvoEvent(
        { tgAccount: accts[i % 10], peerId: `race${i}`, peerPhone: "+14155550100", firstMsgAt: new Date(replied.getTime() - 1000).toISOString(), repliedAt: replied.toISOString() },
        { via: "api" },
      );
    });
    const [lock] = await Promise.all([lockWeek(null, week.id), ...ingests]);
    expect(lock.ok).toBe(true);

    const inWeek = await db.convo.aggregate({ where: { weekId: week.id, status: "QUALIFIED" }, _sum: { vaCents: true, leadVaCents: true, lmCents: true } });
    const paid = await db.payout.aggregate({ where: { weekId: week.id }, _sum: { amountCents: true } });
    const weekCents = (inWeek._sum.vaCents ?? 0) + (inWeek._sum.leadVaCents ?? 0) + (inWeek._sum.lmCents ?? 0);
    expect(paid._sum.amountCents).toBe(weekCents);
    // events that lost the race went to the open week, flagged late
    const late = await db.convo.count({ where: { peerId: { startsWith: "race" }, weekId: { not: week.id } } });
    expect(await db.auditLog.count({ where: { action: "convo.late" } })).toBe(late);
  });
});

describe("paying", () => {
  async function lockedTeam() {
    const t = await makeTeam();
    await db.user.update({ where: { id: t.va.id }, data: { walletAddress: W1 } });
    await qualifyLastWeek(t.account.username, "p");
    const week = await lastWeekRow();
    await lockWeek(null, week.id);
    const pay = (role: "VA" | "LEAD_VA" | "LEAD_MANAGER") => db.payout.findFirstOrThrow({ where: { weekId: week.id, role } });
    return { t, week, pay, D: asActor(t.director) };
  }

  it("validates tx hash, needs a wallet, can't pay twice, Director only", async () => {
    const { t, pay, D } = await lockedTeam();
    const va = await pay("VA");
    expect((await markPayoutPaid(asActor(t.lm), va.id, HASH)).ok).toBe(false);
    expect((await markPayoutPaid(D, va.id, "nope")).ok).toBe(false);
    expect((await markPayoutPaid(D, va.id, HASH)).ok).toBe(true);
    expect(await pay("VA")).toMatchObject({ status: "SENT", txHash: HASH });
    expect((await markPayoutPaid(D, va.id, HASH)).ok).toBe(false);

    const lvaPayout = await pay("LEAD_VA"); // Lead VA has no wallet
    const r = await markPayoutPaid(D, lvaPayout.id, HASH);
    expect(!r.ok && r.error).toMatch(/No wallet/);
  });

  it("refreshing a missing wallet, then paying everyone, marks the week PAID", async () => {
    const { t, week, pay, D } = await lockedTeam();
    expect((await refreshPayoutWallet(D, (await pay("LEAD_VA")).id)).ok).toBe(false); // still no wallet
    await setWallet(asActor(t.lva), W2);
    await setWallet(asActor(t.lm), W2);
    for (const role of ["LEAD_VA", "LEAD_MANAGER"] as const) expect((await refreshPayoutWallet(D, (await pay(role)).id)).ok).toBe(true);
    expect((await pay("LEAD_VA")).walletAddress).toBe(W2);

    for (const role of ["VA", "LEAD_VA"] as const) await markPayoutPaid(D, (await pay(role)).id, HASH);
    expect((await db.week.findUniqueOrThrow({ where: { id: week.id } })).status).toBe("LOCKED");
    await markPayoutPaid(D, (await pay("LEAD_MANAGER")).id, HASH);
    expect((await db.week.findUniqueOrThrow({ where: { id: week.id } })).status).toBe("PAID");
  });

  it("failed payouts block PAID until fixed", async () => {
    const { pay, week, D } = await lockedTeam();
    expect((await markPayoutFailed(D, (await pay("VA")).id)).ok).toBe(true);
    expect((await pay("VA")).status).toBe("FAILED");
    expect((await db.week.findUniqueOrThrow({ where: { id: week.id } })).status).toBe("LOCKED");
  });
});

describe("setWallet", () => {
  it("validates, audits before/after, and the Director can't set one", async () => {
    const t = await makeTeam();
    expect((await setWallet(asActor(t.va), "0x123")).ok).toBe(false);
    expect((await setWallet(asActor(t.va), ` ${W1} `)).ok).toBe(true);
    await setWallet(asActor(t.va), W2);
    const logs = await db.auditLog.findMany({ where: { action: "wallet.set", target: t.va.id }, orderBy: { createdAt: "asc" } });
    expect(logs.map((l) => l.meta)).toEqual([{ before: null, after: W1 }, { before: W1, after: W2 }]);
    expect((await setWallet(asActor(t.director), W1)).ok).toBe(false);
  });
});

describe("commissionSummary", () => {
  it("Lead VA: current week unpaid, paid to date from SENT payouts, average/best over completed weeks only", async () => {
    const { commissionSummary } = await import("@/lib/stats");
    const t = await makeTeam();
    await db.user.update({ where: { id: t.lva.id }, data: { walletAddress: W2 } });
    for (let i = 0; i < 3; i++) await qualifyLastWeek(t.account.username, `last${i}`, i);
    const now = new Date();
    await ingestConvoEvent(
      { tgAccount: t.account.username, peerId: "now", peerPhone: "+14155550100", firstMsgAt: new Date(now.getTime() - 120_000).toISOString(), repliedAt: new Date(now.getTime() - 60_000).toISOString() },
      { via: "api" },
    );
    const week = await lastWeekRow();
    await lockWeek(null, week.id);
    await markPayoutPaid(asActor(t.director), (await db.payout.findFirstOrThrow({ where: { role: "LEAD_VA" } })).id, HASH);

    const s = await commissionSummary({ ...asActor(t.lva), role: "LEAD_VA" }, thisWeek());
    expect(s.currentCents).toBe(10);
    expect(s.currentConvos).toBe(1);
    expect(s.paidToDateCents).toBe(30);
    expect(s.totalConvos).toBe(4);
    expect(s.weeklyAverageCents).toBe(30); // last week only; the current week isn't averaged in
    expect(s.bestWeek?.cents).toBe(30);
    expect(s.history).toMatchObject([{ amountCents: 30, convos: 3, status: "SENT" }]);

    // The LM sees only their own commission column and payouts, never the Lead VA's.
    const lm = await commissionSummary({ ...asActor(t.lm), role: "LEAD_MANAGER" }, thisWeek());
    expect(lm.currentCents).toBe(5);
    expect(lm.paidToDateCents).toBe(0);
    expect(lm.history.every((h) => h.amountCents === 15)).toBe(true);
  });
});
