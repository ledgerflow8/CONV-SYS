import { beforeEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { ingestConvoEvent } from "@/lib/ingest";
import { freeAccountsForVa, replaceFrozenTg } from "@/lib/reassign";
import { asActor, makeAccount, makeTeam, resetDb, setSetting } from "../../test/fixtures";

beforeEach(async () => {
  await resetDb();
  await setSetting("rates", { va: 25, leadVa: 10, lm: 5 });
});

describe("replaceFrozenTg", () => {
  it("freezes the old account, assigns a free one, keeps convos + tracking link", async () => {
    const t = await makeTeam();
    const spare = await makeAccount(t.model.id); // AVAILABLE replacement
    const convo = await ingestConvoEvent(
      { tgAccount: t.account.username, peerId: "fan-1", peerPhone: "+14155550100", firstMsgAt: new Date().toISOString() },
      { via: "api" },
    );
    expect(convo.ok).toBe(true);

    const r = await replaceFrozenTg(asActor(t.lva), t.va.id);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data).toMatchObject({ oldAccount: t.account.username, newAccount: spare.username });

    expect(await db.tgAccount.findUniqueOrThrow({ where: { id: t.account.id } })).toMatchObject({ status: "FROZEN", vaId: null });
    expect(await db.tgAccount.findUniqueOrThrow({ where: { id: spare.id } })).toMatchObject({ status: "ASSIGNED", vaId: t.va.id });
    // The frozen account keeps its past convos, still attributed to the VA.
    expect(convo.ok && (await db.convo.findUniqueOrThrow({ where: { id: convo.data.convoId } }))).toMatchObject({ tgAccountId: t.account.id, vaId: t.va.id });
    // The old assignment is closed as "frozen"; the new one is open.
    expect(await db.tgAssignment.count({ where: { tgAccountId: t.account.id, endedAt: { not: null }, endReason: "frozen" } })).toBe(1);
    expect(await db.tgAssignment.count({ where: { tgAccountId: spare.id, endedAt: null } })).toBe(1);
    expect(await db.trackingLink.findUniqueOrThrow({ where: { vaId: t.va.id } })).toMatchObject({ active: true });
    expect(await db.auditLog.count({ where: { action: "tg.replace", target: t.va.id } })).toBe(1);
  });

  it("can pick a specific free account", async () => {
    const t = await makeTeam();
    await makeAccount(t.model.id); // another free one we won't pick
    const chosen = await makeAccount(t.model.id);
    const r = await replaceFrozenTg(asActor(t.director), t.va.id, { accountId: chosen.id });
    expect(r.ok && r.data.newAccount).toBe(chosen.username);
    expect(await db.tgAccount.findUniqueOrThrow({ where: { id: chosen.id } })).toMatchObject({ status: "ASSIGNED", vaId: t.va.id });
  });

  it("errors and changes nothing when the pool is empty", async () => {
    const t = await makeTeam(); // only the VA's current account exists, no spare
    const r = await replaceFrozenTg(asActor(t.lva), t.va.id);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/No free Telegram accounts/);
    // Nothing changed: the VA still holds the same, still-ASSIGNED account.
    expect(await db.tgAccount.findUniqueOrThrow({ where: { id: t.account.id } })).toMatchObject({ status: "ASSIGNED", vaId: t.va.id });
  });

  it("a Lead VA can only replace their own VA", async () => {
    const mine = await makeTeam();
    const other = await makeTeam();
    await makeAccount(other.model.id);
    const r = await replaceFrozenTg(asActor(mine.lva), other.va.id);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/VA not found/);
  });

  it("freeAccountsForVa lists only the VA model's free, named accounts, scoped to the actor", async () => {
    const t = await makeTeam();
    const free = await makeAccount(t.model.id);
    const r = await freeAccountsForVa(asActor(t.lva), t.va.id);
    expect(r.ok && r.data.map((a) => a.id)).toEqual([free.id]);
  });
});
