import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { CapitalAIError, setCapitalAIForTests, type CapitalAIClient, type Conversation, type SearchRow } from "@/lib/capitalai";
import { getSyncState, syncCapitalAI } from "@/lib/capitalai-sync";
import { makeTeam, minutesAgo, resetDb } from "../../test/fixtures";

// Simulated CapitalAI
let rows: SearchRow[] = [];
let convs = new Map<number, Conversation>();
let fail: CapitalAIError | null = null;
const fetched: number[] = [];
const searches: { startDate: Date; offset: number }[] = [];
const fake: CapitalAIClient = {
  async search(o) {
    if (fail) throw fail;
    searches.push(o);
    return { rows: rows.slice(o.offset, o.offset + 100), hasMore: o.offset + 100 < rows.length };
  },
  async conversation(id) {
    if (fail) throw fail;
    fetched.push(id);
    return convs.get(id) ?? null;
  },
};
setCapitalAIForTests(fake);
afterAll(() => setCapitalAIForTests(null));

function addConv(id: number, accountId: string, identifier: string, transcript: Conversation["transcript"]) {
  rows.push({ conversation_id: id, identifier, accountId, updated_at: new Date().toISOString() });
  convs.set(id, { conversation: { id, identifier, accountId }, transcript });
}
const fanThenReply = (fanMin: number, replyMin?: number): Conversation["transcript"] => [
  { role: "user", timestamp: minutesAgo(fanMin).toISOString() },
  ...(replyMin !== undefined ? [{ role: "assistant", timestamp: minutesAgo(replyMin).toISOString() }] : []),
];

beforeEach(async () => {
  await resetDb();
  rows = [];
  convs = new Map();
  fail = null;
  fetched.length = 0;
  searches.length = 0;
});

describe("syncCapitalAI", () => {
  it("ingests our accounts' conversations, skips other accounts, attributes to the VA", async () => {
    const t = await makeTeam();
    addConv(1, `@${t.account.username.toUpperCase()}`, "fan1", fanThenReply(10, 5));
    addConv(2, "snapchat_account_x", "fan2", fanThenReply(10, 5));
    addConv(3, t.account.username, "fan3", fanThenReply(10)); // no reply yet

    const r = await syncCapitalAI();
    expect(r.ok && r.summary).toMatchObject({ listed: 3, ours: 2, notOurs: 1, errors: [], complete: true });
    const c1 = await db.convo.findUniqueOrThrow({ where: { accountRef_peerId: { accountRef: t.account.username, peerId: "fan1" } } });
    expect(c1).toMatchObject({ vaId: t.va.id, status: "REVIEW", reviewReason: "unknown_country" }); // no phone/click → review
    const c3 = await db.convo.findUniqueOrThrow({ where: { accountRef_peerId: { accountRef: t.account.username, peerId: "fan3" } } });
    expect(c3.status).toBe("PENDING");
    expect(await db.convo.count()).toBe(2);
  });

  it("country comes from the VA's tracking-link click, so convos can qualify without a phone", async () => {
    const t = await makeTeam();
    await db.linkClick.create({ data: { linkId: t.link.id, vaId: t.va.id, tgAccountId: t.account.id, country: "US", createdAt: minutesAgo(12) } });
    addConv(1, t.account.username, "fan1", fanThenReply(10, 5));
    const r = await syncCapitalAI();
    expect(r.ok && r.summary.byStatus).toEqual({ QUALIFIED: 1 });
  });

  it("re-running is harmless and skips decided convos without fetching transcripts", async () => {
    const t = await makeTeam();
    await db.linkClick.create({ data: { linkId: t.link.id, vaId: t.va.id, tgAccountId: t.account.id, country: "US", createdAt: minutesAgo(12) } });
    addConv(1, t.account.username, "fan1", fanThenReply(10, 5));
    await syncCapitalAI();
    fetched.length = 0;
    const r = await syncCapitalAI();
    expect(r.ok && r.summary).toMatchObject({ skippedFinal: 1 });
    expect(fetched).toEqual([]);
    expect(await db.convo.count()).toBe(1);
  });

  it("cursor: first run looks back 3 days; later runs from the last cursor minus 2h overlap", async () => {
    await makeTeam();
    const t0 = new Date("2026-10-09T12:00:00Z");
    await syncCapitalAI({ now: t0 });
    expect(searches[0].startDate.toISOString()).toBe("2026-10-06T12:00:00.000Z");
    expect((await getSyncState()).cursor).toBe(t0.toISOString());
    await syncCapitalAI({ now: new Date("2026-10-09T12:05:00Z") });
    expect(searches[1].startDate.toISOString()).toBe("2026-10-09T10:00:00.000Z");
  });

  it("pages through results", async () => {
    const t = await makeTeam();
    for (let i = 0; i < 230; i++) addConv(i, i % 2 ? "other_acct" : t.account.username, `fan${i}`, fanThenReply(10));
    const r = await syncCapitalAI();
    expect(r.ok && r.summary).toMatchObject({ listed: 230, ours: 115, notOurs: 115 });
    expect(searches.map((s) => s.offset)).toEqual([0, 100, 200]);
  });

  it("a licence error stops the run, is recorded, and doesn't move the cursor", async () => {
    await makeTeam();
    fail = new CapitalAIError("CapitalAI /api/dashboard/search: 400 License expired 37 days ago", 400);
    const r = await syncCapitalAI({ now: new Date("2026-10-09T12:00:00Z") });
    expect(r.ok).toBe(false);
    const s = await getSyncState();
    expect(s.cursor ?? null).toBeNull();
    expect(s.lastRun).toMatchObject({ ok: false, error: expect.stringMatching(/License expired/) });
    expect(s.lockedUntil).toBeNull();
  });

  it("time budget: stops early, leaves the cursor so the next run continues", async () => {
    const t = await makeTeam();
    for (let i = 0; i < 20; i++) addConv(i, t.account.username, `fan${i}`, fanThenReply(10));
    const r = await syncCapitalAI({ budgetMs: -1, now: new Date("2026-10-09T12:00:00Z") });
    expect(r.ok && r.summary.complete).toBe(false);
    expect((await getSyncState()).cursor ?? null).toBeNull();
  });

  it("overlapping runs: the second one backs off", async () => {
    const t = await makeTeam();
    for (let i = 0; i < 30; i++) addConv(i, t.account.username, `fan${i}`, fanThenReply(10));
    const [a, b] = await Promise.all([syncCapitalAI(), syncCapitalAI()]);
    expect([a.ok, b.ok].sort()).toEqual([false, true]);
    expect([a, b].some((x) => !x.ok && x.busy)).toBe(true);
    expect(await db.convo.count()).toBe(30);
  });

  it("sync state never leaks into the Director's settings", async () => {
    await makeTeam();
    await syncCapitalAI();
    const { getAllSettings } = await import("@/lib/settings");
    expect(Object.keys(await getAllSettings())).not.toContain("sync:capitalai");
  });
});
