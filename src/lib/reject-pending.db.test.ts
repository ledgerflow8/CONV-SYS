import { beforeEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { countPendingOlderThan, ingestConvoEvent, rejectPendingConvos, rejectPendingOlderThan } from "@/lib/ingest";
import { lockWeek } from "@/lib/payouts";
import { weekBounds } from "@/lib/weeks";
import { asActor, makeTeam, resetDb, setSetting } from "../../test/fixtures";

const TZ = "Etc/GMT-2";

async function pending(account: string, peerId: string, firstMsgAt: Date, phone = "+14155550100") {
  const r = await ingestConvoEvent({ tgAccount: account, peerId, peerPhone: phone, firstMsgAt: firstMsgAt.toISOString() }, { via: "api" });
  if (!r.ok) throw new Error(r.error);
  return r.data.convoId;
}

beforeEach(async () => {
  await resetDb();
  await setSetting("rates", { va: 25, leadVa: 10, lm: 5 });
});

describe("rejectPendingConvos", () => {
  it("rejects selected pending convos and audits each", async () => {
    const t = await makeTeam();
    const a = await pending(t.account.username, "fan-a", new Date());
    const b = await pending(t.account.username, "fan-b", new Date());

    const r = await rejectPendingConvos(asActor(t.director), [a, b]);
    expect(r.ok && r.data).toEqual({ rejected: 2, skipped: [] });
    for (const id of [a, b]) {
      const c = await db.convo.findUniqueOrThrow({ where: { id } });
      expect(c).toMatchObject({ status: "REJECTED", rejectReason: "manual_reject" });
      expect(await db.auditLog.count({ where: { target: id, action: "convo.status" } })).toBeGreaterThan(0);
    }
  });

  it("skips a convo that is no longer pending", async () => {
    const t = await makeTeam();
    const id = await pending(t.account.username, "fan-a", new Date());
    await db.convo.update({ where: { id }, data: { status: "REJECTED" } });
    const r = await rejectPendingConvos(asActor(t.director), [id]);
    expect(r.ok && r.data.rejected).toBe(0);
    expect(r.ok && r.data.skipped[0]?.reason).toBe("Not pending any more");
  });

  it("a Lead Manager can only reject convos in their own scope", async () => {
    const mine = await makeTeam();
    const other = await makeTeam();
    const minePending = await pending(mine.account.username, "fan-a", new Date());
    const otherPending = await pending(other.account.username, "fan-b", new Date());

    const r = await rejectPendingConvos(asActor(mine.lm), [minePending, otherPending]);
    expect(r.ok && r.data.rejected).toBe(1);
    expect(await db.convo.findUniqueOrThrow({ where: { id: minePending } })).toMatchObject({ status: "REJECTED" });
    expect(await db.convo.findUniqueOrThrow({ where: { id: otherPending } })).toMatchObject({ status: "PENDING" }); // untouched
    expect(r.ok && r.data.skipped[0]).toMatchObject({ convoId: otherPending, reason: "Not in your scope" });
  });

  it("never touches a convo in a locked week", async () => {
    const t = await makeTeam();
    const id = await pending(t.account.username, "fan-a", new Date());
    const lastWeek = weekBounds(new Date(weekBounds(new Date(), TZ).startsAt.getTime() - 1), TZ); // already ended
    const week = await db.week.create({ data: { ...lastWeek } });
    const locked = await lockWeek(null, week.id); // ended → locks with no payouts
    expect(locked.ok).toBe(true);
    await db.convo.update({ where: { id }, data: { weekId: week.id } }); // still PENDING, but now in a locked week

    const r = await rejectPendingConvos(asActor(t.director), [id]);
    expect(r.ok && r.data.skipped[0]?.reason).toBe("In a locked week");
    expect(await db.convo.findUniqueOrThrow({ where: { id } })).toMatchObject({ status: "PENDING" });
  });

  it("only the Director or a Lead Manager may reject", async () => {
    const t = await makeTeam();
    expect((await rejectPendingConvos(asActor(t.lva), ["x"])).ok).toBe(false);
    expect((await rejectPendingConvos(asActor(t.va), ["x"])).ok).toBe(false);
  });
});

describe("rejectPendingOlderThan", () => {
  it("counts and rejects only pending convos older than the cutoff, in scope", async () => {
    const t = await makeTeam();
    const old = await pending(t.account.username, "fan-old", new Date(Date.now() - 50 * 3600_000));
    const recent = await pending(t.account.username, "fan-new", new Date(Date.now() - 2 * 3600_000));

    const preview = await countPendingOlderThan(asActor(t.director), 48);
    expect(preview.ok && preview.data.count).toBe(1);

    const r = await rejectPendingOlderThan(asActor(t.director), 48);
    expect(r.ok && r.data.rejected).toBe(1);
    expect(await db.convo.findUniqueOrThrow({ where: { id: old } })).toMatchObject({ status: "REJECTED", rejectReason: "manual_reject" });
    expect(await db.convo.findUniqueOrThrow({ where: { id: recent } })).toMatchObject({ status: "PENDING" });
  });

  it("rejects nothing qualified (only PENDING)", async () => {
    const t = await makeTeam();
    const q = await ingestConvoEvent(
      { tgAccount: t.account.username, peerId: "fan-q", peerPhone: "+14155550100", firstMsgAt: new Date(Date.now() - 50 * 3600_000).toISOString(), repliedAt: new Date(Date.now() - 49 * 3600_000).toISOString() },
      { via: "api" },
    );
    expect(q.ok && q.data.status).toBe("QUALIFIED");
    const r = await rejectPendingOlderThan(asActor(t.director), 1);
    expect(r.ok && r.data.rejected).toBe(0);
    expect(q.ok && (await db.convo.findUniqueOrThrow({ where: { id: q.data.convoId } })).status).toBe("QUALIFIED");
  });
});
