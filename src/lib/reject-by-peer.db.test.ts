import { beforeEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { ingestConvoEvent } from "@/lib/ingest";
import { applyPeerReject, parsePeerList, previewPeerReject } from "@/lib/reject-by-peer";
import { lockWeek } from "@/lib/payouts";
import { weekBounds } from "@/lib/weeks";
import { asActor, makeTeam, resetDb, setSetting } from "../../test/fixtures";

const TZ = "Etc/GMT-2";

async function qualified(account: string, peerId: string, phone = "+14155550100", first?: Date, replied?: Date) {
  const firstMsgAt = (first ?? new Date(Date.now() - 3 * 3600_000)).toISOString();
  const repliedAt = (replied ?? new Date(Date.now() - 2 * 3600_000)).toISOString();
  const r = await ingestConvoEvent({ tgAccount: account, peerId, peerPhone: phone, firstMsgAt, repliedAt }, { via: "api" });
  if (!r.ok) throw new Error(r.error);
  return r.data.convoId;
}

const lastWeekStart = () => weekBounds(new Date(weekBounds(new Date(), TZ).startsAt.getTime() - 1), TZ).startsAt;

beforeEach(async () => {
  await resetDb();
  await setSetting("rates", { va: 25, leadVa: 10, lm: 5 });
});

describe("parsePeerList", () => {
  it("handles commas, spaces, @, a header row, blanks and dedupes", () => {
    const rows = parsePeerList("tgAccount,peerId\n@Sophie, 111\nsophie 111\nlily\t222\n\n   \nbad");
    // header skipped; @Sophie/111 and sophie/111 dedupe; lily/222 kept; "bad" has no peerId → invalid
    expect(rows.map((r) => [r.tgAccount, r.peerId, r.status])).toEqual([
      ["sophie", "111", "not_found"],
      ["lily", "222", "not_found"],
      ["bad", "", "invalid"],
    ]);
  });
});

describe("previewPeerReject / applyPeerReject", () => {
  it("categorises every line", async () => {
    const t = await makeTeam();
    const okId = await qualified(t.account.username, "fan-ok");
    const rejId = await qualified(t.account.username, "fan-rej");
    await db.convo.update({ where: { id: rejId }, data: { status: "REJECTED" } });

    const text = `${t.account.username}, fan-ok\n${t.account.username}, fan-rej\n${t.account.username}, fan-missing\ngarbage`;
    const p = await previewPeerReject(asActor(t.director), text);
    expect(p.ok).toBe(true);
    if (!p.ok) return;
    expect(p.data.counts).toMatchObject({ found: 1, already_rejected: 1, not_found: 1, invalid: 1 });
    expect(p.data.rows.find((r) => r.peerId === "fan-ok")).toMatchObject({ status: "found", convoId: okId });
  });

  it("rejecting a qualified convo detaches its week and zeroes the earnings", async () => {
    const t = await makeTeam();
    const id = await qualified(t.account.username, "fan-ok");
    expect(await db.convo.findUniqueOrThrow({ where: { id } })).toMatchObject({ status: "QUALIFIED", vaCents: 25 });

    const r = await applyPeerReject(asActor(t.director), `${t.account.username}, fan-ok`);
    expect(r.ok && r.data.rejected).toBe(1);
    const c = await db.convo.findUniqueOrThrow({ where: { id } });
    expect(c).toMatchObject({ status: "REJECTED", rejectReason: "audit_no_reply", weekId: null, qualifiedAt: null, vaCents: 0, leadVaCents: 0, lmCents: 0 });
  });

  it("never changes a convo in a locked week", async () => {
    const t = await makeTeam();
    // Qualified in last (now-ended) week, so the week can be locked.
    const id = await qualified(t.account.username, "fan-ok", "+14155550100", new Date(lastWeekStart().getTime() + 2 * 3600_000), new Date(lastWeekStart().getTime() + 3 * 3600_000));
    const convo = await db.convo.findUniqueOrThrow({ where: { id } });
    const locked = await lockWeek(null, convo.weekId!); // lock the convo's own week
    expect(locked.ok).toBe(true);
    expect((await db.week.findUniqueOrThrow({ where: { id: convo.weekId! } })).status).toBe("LOCKED");

    const p = await previewPeerReject(asActor(t.director), `${t.account.username}, fan-ok`);
    expect(p.ok && p.data.counts.locked_week).toBe(1);
    const r = await applyPeerReject(asActor(t.director), `${t.account.username}, fan-ok`);
    expect(r.ok && r.data.rejected).toBe(0);
    expect(await db.convo.findUniqueOrThrow({ where: { id } })).toMatchObject({ status: "QUALIFIED" });
  });

  it("is Director only", async () => {
    const t = await makeTeam();
    expect((await previewPeerReject(asActor(t.lm), "a, 1")).ok).toBe(false);
    expect((await applyPeerReject(asActor(t.lm), "a, 1")).ok).toBe(false);
  });
});
