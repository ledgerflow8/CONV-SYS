import { beforeEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { approvePendingConvos, ingestConvoEvent } from "@/lib/ingest";
import { liveBoard } from "@/lib/leaderboard";
import { lockWeek } from "@/lib/payouts";
import { currentPeriods, inWeek, qualifiedTotals } from "@/lib/stats";
import { weekBounds } from "@/lib/weeks";
import { asActor, makeTeam, resetDb, setSetting } from "../../test/fixtures";

const TZ = "Etc/GMT-2";
const thisWeek = () => weekBounds(new Date(), TZ);
const lastWeek = () => weekBounds(new Date(thisWeek().startsAt.getTime() - 1), TZ);

/** A fan wrote; nobody replied (the AI was down). Tier 1 phone, so the only thing missing is the reply. */
async function pendingConvo(account: string, peerId: string, firstMsgAt: Date, phone = "+14155550100") {
  const r = await ingestConvoEvent({ tgAccount: account, peerId, peerPhone: phone, firstMsgAt: firstMsgAt.toISOString() }, { via: "api" });
  if (!r.ok) throw new Error(r.error);
  return r.data.convoId;
}

beforeEach(async () => {
  await resetDb();
  await setSetting("rates", { va: 25, leadVa: 10, lm: 5 });
});

describe("approvePendingConvos (outage override)", () => {
  it("a pending convo from a locked week is paid in the current open week, at today's rates, audited as late", async () => {
    const t = await makeTeam();
    // Sunday of last week, during the "outage"
    const outage = new Date(lastWeek().startsAt.getTime() + 6 * 24 * 3600_000 + 16 * 3600_000);
    const id = await pendingConvo(t.account.username, "fan-1", outage);
    const last = await db.week.upsert({ where: { startsAt: lastWeek().startsAt }, update: {}, create: lastWeek() });
    await lockWeek(null, last.id);
    expect((await db.convo.findUniqueOrThrow({ where: { id } })).status).toBe("PENDING");

    const r = await approvePendingConvos(asActor(t.director), [id]);
    expect(r.ok && r.data).toEqual({ approved: 1, late: 1, skipped: [] });

    const c = await db.convo.findUniqueOrThrow({ where: { id }, include: { week: true } });
    expect(c).toMatchObject({ status: "QUALIFIED", vaCents: 25, leadVaCents: 10, lmCents: 5, repliedAt: null, countrySource: "PHONE" });
    expect(c.week!.startsAt).toEqual(thisWeek().startsAt); // the current open week, not the locked one
    expect(c.week!.status).toBe("OPEN");
    expect(await db.payout.count({ where: { weekId: last.id } })).toBe(0); // the locked week is untouched

    const audits = await db.auditLog.findMany({ where: { target: id }, orderBy: { createdAt: "asc" } });
    expect(audits.map((a) => a.action)).toEqual(["convo.status", "convo.status", "convo.late"]);
    expect(audits[1]).toMatchObject({ actorId: t.director.id, meta: { from: "PENDING", to: "QUALIFIED", reason: "pending_approved", via: "review", late: true } });

    // It counts like any qualified convo: the VA's earnings and this week's leaderboard.
    const { week } = await currentPeriods();
    expect((await qualifiedTotals(asActor(t.va), inWeek(week))).convos).toBe(1);
    expect((await liveBoard("VA", week)).find((r) => r.userId === t.va.id)?.convos).toBe(1);
  });

  it("a pending convo from the open week stays in that week (not late); an unknown country becomes MANUAL", async () => {
    const t = await makeTeam();
    const id = await pendingConvo(t.account.username, "fan-2", new Date(Date.now() - 3600_000), "");
    const r = await approvePendingConvos(asActor(t.director), [id]);
    expect(r.ok && r.data).toEqual({ approved: 1, late: 0, skipped: [] });
    expect(await db.convo.findUniqueOrThrow({ where: { id } })).toMatchObject({ status: "QUALIFIED", country: null, countrySource: "MANUAL" });
  });

  it("is counted once: re-approving skips it, and the fan's later reply changes nothing", async () => {
    const t = await makeTeam();
    const first = new Date(Date.now() - 2 * 3600_000);
    const id = await pendingConvo(t.account.username, "fan-3", first);
    await approvePendingConvos(asActor(t.director), [id]);
    const again = await approvePendingConvos(asActor(t.director), [id, id]);
    expect(again.ok && again.data).toEqual({ approved: 0, late: 0, skipped: [{ convoId: id, reason: "Not pending any more" }] });

    const before = await db.convo.findUniqueOrThrow({ where: { id } });
    await ingestConvoEvent(
      { tgAccount: t.account.username, peerId: "fan-3", peerPhone: "+14155550100", firstMsgAt: first.toISOString(), repliedAt: new Date().toISOString() },
      { via: "api" },
    );
    const after = await db.convo.findUniqueOrThrow({ where: { id } });
    expect(after).toMatchObject({ status: "QUALIFIED", weekId: before.weekId, vaCents: before.vaCents, qualifiedAt: before.qualifiedAt });
    expect(await db.convo.count({ where: { status: "QUALIFIED" } })).toBe(1);
  });

  it("keeps the other rules: no VA on the account, or no longer Tier 1, is skipped with a reason", async () => {
    const t = await makeTeam();
    // Before the VA held the account (makeTeam assigns it 30 days ago) → unattributed.
    const noVa = await pendingConvo(t.account.username, "fan-4", new Date(Date.now() - 40 * 24 * 3600_000));
    const de = await pendingConvo(t.account.username, "fan-5", new Date(Date.now() - 3600_000), "+4915112345678");
    await setSetting("tier1Countries", ["US"]); // the client drops DE after the fan wrote
    const ok = await pendingConvo(t.account.username, "fan-6", new Date(Date.now() - 3600_000));

    const r = await approvePendingConvos(asActor(t.director), [noVa, de, ok, "does-not-exist"]);
    expect(r.ok && r.data.approved).toBe(1);
    expect(r.ok && r.data.skipped).toEqual([
      { convoId: noVa, reason: "No VA held the account" },
      { convoId: de, reason: "Not Tier 1 (DE)" },
      { convoId: "does-not-exist", reason: "Not pending any more" },
    ]);
    expect((await db.convo.findUniqueOrThrow({ where: { id: noVa } })).status).toBe("PENDING");
    expect((await db.convo.findUniqueOrThrow({ where: { id: de } })).status).toBe("PENDING");
  });

  it("Director only, and needs a selection", async () => {
    const t = await makeTeam();
    const id = await pendingConvo(t.account.username, "fan-7", new Date(Date.now() - 3600_000));
    for (const who of [t.lm, t.lva, t.va]) expect((await approvePendingConvos(asActor(who), [id])).ok).toBe(false);
    expect((await approvePendingConvos(asActor(t.director), [])).ok).toBe(false);
    expect((await db.convo.findUniqueOrThrow({ where: { id } })).status).toBe("PENDING");
  });
});
