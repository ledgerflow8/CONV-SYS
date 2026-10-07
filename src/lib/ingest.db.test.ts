import { beforeEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { ingestConvoEvent, retryConvo, reviewConvo } from "@/lib/ingest";
import { weekBounds } from "@/lib/weeks";
import { asActor, assign, makeAccount, makeTeam, makeUser, minutesAgo, resetDb, setSetting } from "../../test/fixtures";

const TZ = "Etc/GMT-2";
const api = { via: "api" as const };

async function ingest(e: Record<string, unknown>) {
  const r = await ingestConvoEvent(e, api);
  if (!r.ok) throw new Error(r.error);
  return r.data;
}

beforeEach(resetDb);

describe("ingestConvoEvent: qualification", () => {
  it("qualifies a replied Tier 1 convo, snapshots attribution, rates and week", async () => {
    const t = await makeTeam();
    const replied = minutesAgo(5);
    const out = await ingest({
      tgAccount: `@${t.account.username.toUpperCase()}`,
      peerId: "p1",
      peerPhone: "+1 415 555 0100",
      firstMsgAt: minutesAgo(10).toISOString(),
      repliedAt: replied.toISOString(),
    });
    expect(out).toMatchObject({ status: "QUALIFIED", changed: true, late: false });

    const c = await db.convo.findUniqueOrThrow({ where: { id: out.convoId }, include: { week: true } });
    expect(c).toMatchObject({
      accountRef: t.account.username,
      tgAccountId: t.account.id,
      vaId: t.va.id,
      leadVaId: t.lva.id,
      leadManagerId: t.lm.id,
      modelId: t.model.id,
      country: "US",
      countrySource: "PHONE",
      vaCents: 25,
      leadVaCents: 10,
      lmCents: 0,
    });
    expect(c.qualifiedAt).not.toBeNull();
    expect(c.week?.startsAt.toISOString()).toBe(weekBounds(replied, TZ).startsAt.toISOString());
  });

  it("rejects a known non-Tier-1 country", async () => {
    const t = await makeTeam();
    const out = await ingest({ tgAccount: t.account.username, peerId: "p", peerPhone: "+234 803 123 4567", firstMsgAt: minutesAgo(9).toISOString(), repliedAt: minutesAgo(1).toISOString() });
    expect(out).toMatchObject({ status: "REJECTED", reason: "non_tier1" });
  });

  it("stays PENDING until the reply arrives, then qualifies the same row", async () => {
    const t = await makeTeam();
    const base = { tgAccount: t.account.username, peerId: "p", peerPhone: "+14155550100", firstMsgAt: minutesAgo(20).toISOString() };
    const a = await ingest(base);
    expect(a.status).toBe("PENDING");
    const b = await ingest({ ...base, peerPhone: undefined, repliedAt: minutesAgo(2).toISOString() });
    expect(b).toMatchObject({ convoId: a.convoId, status: "QUALIFIED", changed: true });
    expect(await db.convo.count()).toBe(1);
  });

  it("a qualified convo never changes again (counts exactly once)", async () => {
    const t = await makeTeam();
    const e = { tgAccount: t.account.username, peerId: "p", peerPhone: "+14155550100", firstMsgAt: minutesAgo(20).toISOString(), repliedAt: minutesAgo(2).toISOString() };
    const a = await ingest(e);
    const before = await db.convo.findUniqueOrThrow({ where: { id: a.convoId } });
    const b = await ingest({ ...e, peerPhone: "+234 803 123 4567" }); // would be non-Tier-1
    expect(b).toMatchObject({ convoId: a.convoId, status: "QUALIFIED", changed: false });
    const after = await db.convo.findUniqueOrThrow({ where: { id: a.convoId } });
    expect(after).toEqual(before);
    expect(await db.auditLog.count({ where: { action: "convo.status", target: a.convoId } })).toBe(1);
  });

  it("refuses bad input", async () => {
    const t = await makeTeam();
    const bad = [
      { tgAccount: t.account.username, peerId: "p", firstMsgAt: "2026-10-07 14:00" }, // no timezone
      { tgAccount: t.account.username, peerId: "p", firstMsgAt: "yesterday" },
      { tgAccount: t.account.username, peerId: "p", firstMsgAt: minutesAgo(1).toISOString(), repliedAt: minutesAgo(5).toISOString() },
      { tgAccount: t.account.username, peerId: "p", firstMsgAt: new Date(Date.now() + 86400_000).toISOString() },
      { tgAccount: "", peerId: "p", firstMsgAt: minutesAgo(1).toISOString() },
    ];
    for (const e of bad) expect((await ingestConvoEvent(e, api)).ok).toBe(false);
    expect(await db.convo.count()).toBe(0);
  });
});

describe("ingestConvoEvent: country from clicks", () => {
  it("uses the VA's most recent click to this account inside the window", async () => {
    const t = await makeTeam();
    await db.linkClick.create({ data: { linkId: t.link.id, vaId: t.va.id, tgAccountId: t.account.id, country: "CA", createdAt: minutesAgo(25) } });
    await db.linkClick.create({ data: { linkId: t.link.id, vaId: t.va.id, tgAccountId: t.account.id, country: "GB", createdAt: minutesAgo(12) } });
    const out = await ingest({ tgAccount: t.account.username, peerId: "p", firstMsgAt: minutesAgo(10).toISOString(), repliedAt: minutesAgo(1).toISOString() });
    const c = await db.convo.findUniqueOrThrow({ where: { id: out.convoId } });
    expect(c).toMatchObject({ status: "QUALIFIED", country: "GB", countrySource: "CLICK" });
    expect(c.clickId).not.toBeNull();
  });

  it("ignores clicks outside the window → unknown country → review", async () => {
    const t = await makeTeam();
    await db.linkClick.create({ data: { linkId: t.link.id, vaId: t.va.id, tgAccountId: t.account.id, country: "US", createdAt: minutesAgo(45) } });
    const out = await ingest({ tgAccount: t.account.username, peerId: "p", firstMsgAt: minutesAgo(10).toISOString(), repliedAt: minutesAgo(1).toISOString() });
    expect(out).toMatchObject({ status: "REVIEW", reason: "unknown_country" });
  });

  it("phone beats click", async () => {
    const t = await makeTeam();
    await db.linkClick.create({ data: { linkId: t.link.id, vaId: t.va.id, tgAccountId: t.account.id, country: "NG", createdAt: minutesAgo(12) } });
    const out = await ingest({ tgAccount: t.account.username, peerId: "p", peerPhone: "+14155550100", firstMsgAt: minutesAgo(10).toISOString(), repliedAt: minutesAgo(1).toISOString() });
    expect(out.status).toBe("QUALIFIED");
  });

  it("a blocked click rejects as blocked_source", async () => {
    const t = await makeTeam();
    await db.linkClick.create({ data: { linkId: t.link.id, vaId: t.va.id, tgAccountId: t.account.id, country: "US", blocked: true, refDomain: "spam.io", createdAt: minutesAgo(12) } });
    const out = await ingest({ tgAccount: t.account.username, peerId: "p", firstMsgAt: minutesAgo(10).toISOString(), repliedAt: minutesAgo(1).toISOString() });
    expect(out).toMatchObject({ status: "REJECTED", reason: "blocked_source" });
  });

  it("a blocked source domain reported by the event rejects too", async () => {
    const t = await makeTeam();
    await setSetting("blockedDomains", ["spam.io"]);
    const out = await ingest({ tgAccount: t.account.username, peerId: "p", peerPhone: "+14155550100", source: "https://x.spam.io/a", firstMsgAt: minutesAgo(10).toISOString(), repliedAt: minutesAgo(1).toISOString() });
    expect(out).toMatchObject({ status: "REJECTED", reason: "blocked_source" });
  });
});

describe("ingestConvoEvent: attribution", () => {
  it("credits whoever held the account at firstMsgAt, not now", async () => {
    const t = await makeTeam();
    const va2 = await makeUser("VA", t.lva.id, t.model.id);
    // VA1 held it until 30 min ago; VA2 since.
    await db.tgAssignment.updateMany({ where: { tgAccountId: t.account.id }, data: { endedAt: minutesAgo(30), endReason: "reassigned" } });
    await assign(t.account.id, va2.id, minutesAgo(30));
    const old = await ingest({ tgAccount: t.account.username, peerId: "a", peerPhone: "+14155550100", firstMsgAt: minutesAgo(40).toISOString(), repliedAt: minutesAgo(1).toISOString() });
    const now = await ingest({ tgAccount: t.account.username, peerId: "b", peerPhone: "+14155550100", firstMsgAt: minutesAgo(10).toISOString(), repliedAt: minutesAgo(1).toISOString() });
    expect((await db.convo.findUniqueOrThrow({ where: { id: old.convoId } })).vaId).toBe(t.va.id);
    expect((await db.convo.findUniqueOrThrow({ where: { id: now.convoId } })).vaId).toBe(va2.id);
  });

  it("no holder at firstMsgAt → review (unattributed)", async () => {
    const t = await makeTeam();
    const spare = await makeAccount(t.model.id);
    const out = await ingest({ tgAccount: spare.username, peerId: "p", peerPhone: "+14155550100", firstMsgAt: minutesAgo(10).toISOString(), repliedAt: minutesAgo(1).toISOString() });
    expect(out).toMatchObject({ status: "REVIEW", reason: "unattributed" });
  });

  it("unknown account → review; after it's added, Retry qualifies the same row", async () => {
    const t = await makeTeam();
    const e = { tgAccount: "@Brand_New_Acct", peerId: "p", peerPhone: "+14155550100", firstMsgAt: minutesAgo(10).toISOString(), repliedAt: minutesAgo(1).toISOString() };
    const a = await ingest(e);
    expect(a).toMatchObject({ status: "REVIEW", reason: "unknown_account" });
    expect((await db.convo.findUniqueOrThrow({ where: { id: a.convoId } })).accountRef).toBe("brand_new_acct");

    const acct = await db.tgAccount.create({ data: { modelId: t.model.id, username: "brand_new_acct", phone: "+13095550111", link: "https://t.me/brand_new_acct" } });
    const va2 = await makeUser("VA", t.lva.id, t.model.id); // a VA holds one account at a time
    await assign(acct.id, va2.id, minutesAgo(60));
    const r = await retryConvo(asActor(t.director), a.convoId);
    expect(r.ok && r.data).toMatchObject({ convoId: a.convoId, status: "QUALIFIED" });
    expect(await db.convo.count()).toBe(1);
  });
});

describe("rates and weeks", () => {
  it("rate changes only affect convos qualified afterwards", async () => {
    const t = await makeTeam();
    const ev = (peerId: string) => ({ tgAccount: t.account.username, peerId, peerPhone: "+14155550100", firstMsgAt: minutesAgo(10).toISOString(), repliedAt: minutesAgo(1).toISOString() });
    const a = await ingest(ev("a"));
    await setSetting("rates", { va: 30, leadVa: 12, lm: 5 });
    const b = await ingest(ev("b"));
    const [ca, cb] = await Promise.all([a, b].map((x) => db.convo.findUniqueOrThrow({ where: { id: x.convoId } })));
    expect([ca.vaCents, ca.leadVaCents, ca.lmCents]).toEqual([25, 10, 0]);
    expect([cb.vaCents, cb.leadVaCents, cb.lmCents]).toEqual([30, 12, 5]);
  });

  it("a reply in a locked week lands in the current open week and is flagged late", async () => {
    const t = await makeTeam();
    const lastWeek = new Date(Date.now() - 7 * 24 * 3600_000);
    const b = weekBounds(lastWeek, TZ);
    const locked = await db.week.create({ data: { ...b, status: "LOCKED" } });
    const out = await ingest({ tgAccount: t.account.username, peerId: "p", peerPhone: "+14155550100", firstMsgAt: new Date(lastWeek.getTime() - 60_000).toISOString(), repliedAt: lastWeek.toISOString() });
    expect(out).toMatchObject({ status: "QUALIFIED", late: true });
    const c = await db.convo.findUniqueOrThrow({ where: { id: out.convoId }, include: { week: true } });
    expect(c.weekId).not.toBe(locked.id);
    expect(c.week?.startsAt.toISOString()).toBe(weekBounds(new Date(), TZ).startsAt.toISOString());
    expect(await db.convo.count({ where: { weekId: locked.id } })).toBe(0);
    expect(await db.auditLog.count({ where: { action: "convo.late", target: c.id } })).toBe(1);
  });
});

describe("review queue", () => {
  async function unknownCountry() {
    const t = await makeTeam();
    const out = await ingest({ tgAccount: t.account.username, peerId: "p", firstMsgAt: minutesAgo(10).toISOString(), repliedAt: minutesAgo(1).toISOString() });
    expect(out.reason).toBe("unknown_country");
    return { t, id: out.convoId };
  }

  it("approve → QUALIFIED with MANUAL country source and rate snapshot", async () => {
    const { t, id } = await unknownCountry();
    const r = await reviewConvo(asActor(t.director), id, "approve");
    expect(r.ok).toBe(true);
    const c = await db.convo.findUniqueOrThrow({ where: { id } });
    expect(c).toMatchObject({ status: "QUALIFIED", countrySource: "MANUAL", vaCents: 25, leadVaCents: 10, reviewReason: null });
    expect(c.weekId).not.toBeNull();
  });

  it("reject → REJECTED review_rejected; can't review twice", async () => {
    const { t, id } = await unknownCountry();
    expect((await reviewConvo(asActor(t.director), id, "reject")).ok).toBe(true);
    expect(await db.convo.findUniqueOrThrow({ where: { id } })).toMatchObject({ status: "REJECTED", rejectReason: "review_rejected" });
    expect((await reviewConvo(asActor(t.director), id, "approve")).ok).toBe(false);
  });

  it("only the Director reviews; unattributed can't be approved", async () => {
    const { t, id } = await unknownCountry();
    expect((await reviewConvo(asActor(t.lm), id, "approve")).ok).toBe(false);
    const spare = await makeAccount(t.model.id);
    const u = await ingest({ tgAccount: spare.username, peerId: "q", peerPhone: "+14155550100", firstMsgAt: minutesAgo(10).toISOString(), repliedAt: minutesAgo(1).toISOString() });
    expect((await reviewConvo(asActor(t.director), u.convoId, "approve")).ok).toBe(false);
  });
});

describe("concurrency", () => {
  it("10 identical events at once → one row, qualified once, one status audit", async () => {
    const t = await makeTeam();
    const e = { tgAccount: t.account.username, peerId: "race", peerPhone: "+14155550100", firstMsgAt: minutesAgo(10).toISOString(), repliedAt: minutesAgo(1).toISOString() };
    const results = await Promise.all(Array.from({ length: 10 }, () => ingestConvoEvent(e, api)));
    expect(results.every((r) => r.ok && r.data.status === "QUALIFIED")).toBe(true);
    expect(await db.convo.count()).toBe(1);
    expect(results.filter((r) => r.ok && r.data.changed)).toHaveLength(1);
    expect(await db.auditLog.count({ where: { action: "convo.status" } })).toBe(1);
  });
});
