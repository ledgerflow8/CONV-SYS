import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { ingestConvoEvent } from "@/lib/ingest";
import { setNotifierForTests } from "@/lib/notify";
import { assignAccountToVa, restoreAccount, takeAccountOutOfService } from "@/lib/reassign";
import { asActor, makeAccount, makeTeam, makeUser, minutesAgo, resetDb } from "../../test/fixtures";

const sent: { to: bigint; text: string }[] = [];
setNotifierForTests({ send: async (to, text) => void sent.push({ to, text }) });
afterAll(() => setNotifierForTests(null));

beforeEach(async () => {
  await resetDb();
  sent.length = 0;
});

describe("ban / reassign", () => {
  it("ban: assignment ends, VA gets the next free account, tracking link unchanged, VA notified", async () => {
    const t = await makeTeam();
    await db.user.update({ where: { id: t.va.id }, data: { telegramUserId: BigInt(555) } });
    const spare = await makeAccount(t.model.id);

    const r = await takeAccountOutOfService(asActor(t.director), t.account.id, "BANNED");
    expect(r.ok && r.data).toMatchObject({ vaId: t.va.id, replacement: spare.username, notified: "sent" });

    expect(await db.tgAccount.findUniqueOrThrow({ where: { id: t.account.id } })).toMatchObject({ status: "BANNED", vaId: null });
    expect(await db.tgAccount.findUniqueOrThrow({ where: { id: spare.id } })).toMatchObject({ status: "ASSIGNED", vaId: t.va.id });
    const hist = await db.tgAssignment.findMany({ where: { vaId: t.va.id }, orderBy: { startedAt: "asc" } });
    expect(hist.map((h) => [h.tgAccountId, h.endReason, h.endedAt === null])).toEqual([
      [t.account.id, "banned", false],
      [spare.id, null, true],
    ]);
    expect((await db.trackingLink.findUniqueOrThrow({ where: { vaId: t.va.id } })).slug).toBe(t.link.slug);
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toBe(BigInt(555));
    expect(sent[0].text).toContain(`@${spare.username}`);
    expect(sent[0].text).toContain(`/v/${t.link.slug}`);
  });

  it("convos keep their attribution across a ban: before → old account's VA, after → new account", async () => {
    const t = await makeTeam();
    const spare = await makeAccount(t.model.id);
    const before = await ingestConvoEvent(
      { tgAccount: t.account.username, peerId: "b", peerPhone: "+14155550100", firstMsgAt: minutesAgo(30).toISOString() },
      { via: "api" },
    );
    await takeAccountOutOfService(asActor(t.director), t.account.id, "BANNED");
    const after = await ingestConvoEvent(
      { tgAccount: spare.username, peerId: "a", peerPhone: "+14155550100", firstMsgAt: new Date().toISOString(), repliedAt: new Date().toISOString() },
      { via: "api" },
    );
    if (!before.ok || !after.ok) throw new Error("setup");
    expect((await db.convo.findUniqueOrThrow({ where: { id: before.data.convoId } })).vaId).toBe(t.va.id);
    expect((await db.convo.findUniqueOrThrow({ where: { id: after.data.convoId } })).vaId).toBe(t.va.id);
  });

  it("empty pool: VA is left without an account and told so; Lead VA assigns later", async () => {
    const t = await makeTeam();
    await db.user.update({ where: { id: t.va.id }, data: { telegramUserId: BigInt(556) } });
    const r = await takeAccountOutOfService(asActor(t.director), t.account.id, "RETIRED");
    expect(r.ok && r.data.replacement).toBeNull();
    expect(await db.tgAccount.findUnique({ where: { vaId: t.va.id } })).toBeNull();
    expect(sent[0].text).toMatch(/No replacement is free/);

    expect((await assignAccountToVa(asActor(t.lva), t.va.id)).ok).toBe(false); // still empty
    const fresh = await makeAccount(t.model.id);
    const a = await assignAccountToVa(asActor(t.lva), t.va.id);
    expect(a.ok && a.data).toMatchObject({ account: fresh.username, notified: "sent" });
    expect((await assignAccountToVa(asActor(t.lva), t.va.id)).ok).toBe(false); // already has one
  });

  it("permissions: only the Director bans/restores; only the VA's own Lead VA assigns", async () => {
    const t = await makeTeam();
    expect((await takeAccountOutOfService(asActor(t.lva), t.account.id, "BANNED")).ok).toBe(false);
    expect((await takeAccountOutOfService(asActor(t.lm), t.account.id, "BANNED")).ok).toBe(false);
    await takeAccountOutOfService(asActor(t.director), t.account.id, "BANNED");
    expect((await restoreAccount(asActor(t.lva), t.account.id)).ok).toBe(false);

    const otherLva = await makeUser("LEAD_VA", t.lm.id, t.model.id);
    await makeAccount(t.model.id);
    expect((await assignAccountToVa(asActor(otherLva), t.va.id)).ok).toBe(false);
  });

  it("restore puts a banned account back as AVAILABLE; banning twice is refused", async () => {
    const t = await makeTeam();
    await takeAccountOutOfService(asActor(t.director), t.account.id, "BANNED");
    expect((await takeAccountOutOfService(asActor(t.director), t.account.id, "BANNED")).ok).toBe(false);
    expect((await restoreAccount(asActor(t.director), t.account.id)).ok).toBe(true);
    expect(await db.tgAccount.findUniqueOrThrow({ where: { id: t.account.id } })).toMatchObject({ status: "AVAILABLE", vaId: null });
    expect((await restoreAccount(asActor(t.director), t.account.id)).ok).toBe(false);
  });

  it("unlinked VA: change still happens, notification reported as not_linked", async () => {
    const t = await makeTeam();
    await makeAccount(t.model.id);
    const r = await takeAccountOutOfService(asActor(t.director), t.account.id, "BANNED");
    expect(r.ok && r.data.notified).toBe("not_linked");
    expect(sent).toHaveLength(0);
  });

  it("two Lead VA clicks at once hand out one account, not two", async () => {
    const t = await makeTeam();
    await takeAccountOutOfService(asActor(t.director), t.account.id, "RETIRED"); // pool empty → VA has none
    await makeAccount(t.model.id);
    await makeAccount(t.model.id);
    const results = await Promise.all([assignAccountToVa(asActor(t.lva), t.va.id), assignAccountToVa(asActor(t.lva), t.va.id)]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(await db.tgAccount.count({ where: { vaId: t.va.id } })).toBe(1);
    expect(await db.tgAccount.count({ where: { status: "AVAILABLE" } })).toBe(1);
  });
});
