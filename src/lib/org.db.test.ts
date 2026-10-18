// Client feedback 2026-10-18: inactive models, rename, team moves, firing at every level, re-adding.
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { ingestConvoEvent } from "@/lib/ingest";
import { renameModel, setModelActive } from "@/lib/models";
import { setNotifierForTests } from "@/lib/notify";
import { bulkMoveTeams, findInactiveVas, fireInactiveVas, fireUser, moveTeam, planBulkMove, planFire, planTeamMove } from "@/lib/org";
import { lockWeek } from "@/lib/payouts";
import { createManagedUser } from "@/lib/people";
import { addPoolAccount } from "@/lib/pool";
import { addVa } from "@/lib/team";
import { weekBounds } from "@/lib/weeks";
import { asActor, assign, makeAccount, makeModel, makeTeam, makeUser, minutesAgo, resetDb } from "../../test/fixtures";

const sent: { to: bigint; text: string }[] = [];
setNotifierForTests({ send: async (to, text) => void sent.push({ to, text }) });
afterAll(() => setNotifierForTests(null));

beforeEach(async () => {
  await resetDb();
  sent.length = 0;
});

/** A Lead VA team on `model` with `n` VAs, each holding one account, Telegram-linked. */
async function team(lmId: string, modelId: string, n: number) {
  const lva = await makeUser("LEAD_VA", lmId, modelId);
  const vas = [];
  for (let i = 0; i < n; i++) {
    const va = await makeUser("VA", lva.id, modelId);
    await db.user.update({ where: { id: va.id }, data: { telegramUserId: BigInt(7000 + vas.length + Math.floor(Math.random() * 1e6)) } });
    const acct = await makeAccount(modelId);
    await assign(acct.id, va.id);
    await db.trackingLink.create({ data: { vaId: va.id, slug: `s${va.id.slice(-8)}` } });
    vas.push({ ...va, account: acct });
  }
  return { lva, vas };
}

const accountOf = (vaId: string) => db.tgAccount.findUnique({ where: { vaId } });

describe("1. inactive models", () => {
  it("can't be picked for a new team, can't take new VAs, but show as inactive", async () => {
    const t = await makeTeam();
    await makeAccount(t.model.id);
    await setModelActive(asActor(t.director), t.model.id, false);
    expect((await createManagedUser(asActor(t.lm), { role: "LEAD_VA", handle: "new_lead", modelId: t.model.id })).ok).toBe(false);
    const add = await addVa(asActor(t.lva), "new_va_person");
    expect(!add.ok && add.error).toMatch(/inactive/);
    expect((await db.model.findUniqueOrThrow({ where: { id: t.model.id } })).active).toBe(false);
  });
});

describe("2. rename model", () => {
  it("renames by id, Director only, names stay unique", async () => {
    const t = await makeTeam();
    const other = await makeModel();
    expect((await renameModel(asActor(t.lm), t.model.id, "Sarrish")).ok).toBe(false);
    expect((await renameModel(asActor(t.director), t.model.id, other.name.toUpperCase())).ok).toBe(false);
    expect((await renameModel(asActor(t.director), t.model.id, "  Sarrish ")).ok).toBe(true);
    // Everything that points at the model by id now shows the new name.
    const lva = await db.user.findUniqueOrThrow({ where: { id: t.lva.id }, select: { model: { select: { name: true } } } });
    expect(lva.model?.name).toBe("Sarrish");
    const log = await db.auditLog.findFirstOrThrow({ where: { action: "model.rename" } });
    expect(log.meta).toMatchObject({ after: "Sarrish" });
  });
});

describe("3. moving teams between models", () => {
  it("swaps every VA's account into the new pool, keeps tracking links, notifies, leaves earnings alone", async () => {
    const t = await makeTeam();
    const B = await makeModel();
    const { lva, vas } = await team(t.lm.id, t.model.id, 2);
    const bAccts = [await makeAccount(B.id), await makeAccount(B.id)];
    // A qualified convo before the move stays credited to the old team.
    const done = await ingestConvoEvent(
      { tgAccount: vas[0].account.username, peerId: "f1", peerPhone: "+14155550100", firstMsgAt: minutesAgo(5).toISOString(), repliedAt: minutesAgo(1).toISOString() },
      { via: "api" },
    );
    if (!done.ok) throw new Error(done.error);
    const before = await db.convo.findUniqueOrThrow({ where: { id: done.data.convoId } });
    const slugs = await db.trackingLink.findMany({ where: { vaId: { in: vas.map((v) => v.id) } }, orderBy: { vaId: "asc" } });

    const preview = await planTeamMove(asActor(t.director), lva.id, B.id);
    expect(preview.ok && preview.data).toMatchObject({ vasMoving: 2, available: 2, short: 0 });

    const r = await moveTeam(asActor(t.director), lva.id, B.id);
    expect(r.ok && r.data).toEqual({ teams: 1, vas: 2, withAccount: 2, needAccount: 0 });

    for (const v of vas) {
      const a = await accountOf(v.id);
      expect(bAccts.map((x) => x.id)).toContain(a?.id);
      expect((await db.tgAccount.findUniqueOrThrow({ where: { id: v.account.id } })).status).toBe("AVAILABLE"); // back in A's pool
      expect((await db.user.findUniqueOrThrow({ where: { id: v.id } })).modelId).toBe(B.id);
    }
    expect((await db.user.findUniqueOrThrow({ where: { id: lva.id } })).modelId).toBe(B.id);
    expect(await db.trackingLink.findMany({ where: { vaId: { in: vas.map((v) => v.id) } }, orderBy: { vaId: "asc" } })).toEqual(slugs);
    expect(sent).toHaveLength(2);
    expect(sent[0].text).toMatch(/different model/);
    expect(await db.convo.findUniqueOrThrow({ where: { id: done.data.convoId } })).toEqual(before);
  });

  it("short pool: refuses until confirmed, then flags VAs who need an account and fills them when the pool is refilled", async () => {
    const t = await makeTeam();
    const B = await makeModel();
    const { lva, vas } = await team(t.lm.id, t.model.id, 3);
    await makeAccount(B.id);

    const preview = await planTeamMove(asActor(t.director), lva.id, B.id);
    expect(preview.ok && preview.data).toMatchObject({ vasMoving: 3, available: 1, short: 2 });
    const refused = await moveTeam(asActor(t.director), lva.id, B.id);
    expect(!refused.ok && refused.error).toMatch(/2 short/);
    expect((await db.user.findUniqueOrThrow({ where: { id: lva.id } })).modelId).toBe(t.model.id); // nothing moved

    const r = await moveTeam(asActor(t.director), lva.id, B.id, { allowShort: true });
    expect(r.ok && r.data).toMatchObject({ withAccount: 1, needAccount: 2 });
    const waiting = await db.user.count({ where: { id: { in: vas.map((v) => v.id) }, tgAccount: null } });
    expect(waiting).toBe(2);

    // The Director adds accounts to B: the waiting VAs get them automatically and are told.
    sent.length = 0;
    await addPoolAccount(asActor(t.director), { modelId: B.id, username: "b_new_one", phone: "+13095550123" });
    expect(await db.user.count({ where: { id: { in: vas.map((v) => v.id) }, tgAccount: null } })).toBe(1);
    expect(sent).toHaveLength(1);
    expect(sent[0].text).toMatch(/assigned a Telegram account/);
  });

  it("a Lead Manager moves only their own teams; destination must be active; locked weeks don't change", async () => {
    const t = await makeTeam();
    const B = await makeModel();
    const otherLm = await makeUser("LEAD_MANAGER", t.director.id);
    await makeAccount(B.id);
    expect((await moveTeam(asActor(otherLm), t.lva.id, B.id, { allowShort: true })).ok).toBe(false);

    // Lock last week with a payout in it, then move: the locked week is untouched.
    const last = weekBounds(new Date(Date.now() - 7 * 86400_000), "Etc/GMT-2");
    const r0 = await ingestConvoEvent(
      { tgAccount: t.account.username, peerId: "old", peerPhone: "+14155550100", firstMsgAt: new Date(last.startsAt.getTime() + 3600_000).toISOString(), repliedAt: new Date(last.startsAt.getTime() + 7200_000).toISOString() },
      { via: "api" },
    );
    if (!r0.ok) throw new Error(r0.error);
    const week = await db.week.findUniqueOrThrow({ where: { startsAt: last.startsAt } });
    await lockWeek(null, week.id);
    const payoutsBefore = await db.payout.findMany({ where: { weekId: week.id }, orderBy: { id: "asc" } });

    await setModelActive(asActor(t.director), B.id, false);
    expect((await moveTeam(asActor(t.lm), t.lva.id, B.id, { allowShort: true })).ok).toBe(false); // inactive
    await setModelActive(asActor(t.director), B.id, true);
    expect((await moveTeam(asActor(t.lm), t.lva.id, B.id, { allowShort: true })).ok).toBe(true);
    expect(await db.payout.findMany({ where: { weekId: week.id }, orderBy: { id: "asc" } })).toEqual(payoutsBefore);
  });

  it("bulk: moves every team of A to B, after a preview of the totals", async () => {
    const t = await makeTeam(); // 1 VA on A
    const B = await makeModel();
    await team(t.lm.id, t.model.id, 2);
    for (let i = 0; i < 2; i++) await makeAccount(B.id);
    const p = await planBulkMove(asActor(t.director), t.model.id, B.id);
    expect(p.ok && p.data).toMatchObject({ vasMoving: 3, available: 2, short: 1 });
    expect(p.ok && p.data.teams).toHaveLength(2);
    expect((await bulkMoveTeams(asActor(t.director), t.model.id, B.id)).ok).toBe(false); // short, not confirmed
    const r = await bulkMoveTeams(asActor(t.director), t.model.id, B.id, { allowShort: true });
    expect(r.ok && r.data).toEqual({ teams: 2, vas: 3, withAccount: 2, needAccount: 1 });
    expect(await db.user.count({ where: { role: "LEAD_VA", modelId: t.model.id } })).toBe(0);
    expect((await planBulkMove(asActor(t.lm), t.model.id, B.id)).ok).toBe(false); // Director only
  });
});

describe("4. firing at every level", () => {
  it("Lead VA fires a VA: login blocked, link off, account back to the pool, earnings kept", async () => {
    const t = await makeTeam();
    const done = await ingestConvoEvent(
      { tgAccount: t.account.username, peerId: "f", peerPhone: "+14155550100", firstMsgAt: minutesAgo(5).toISOString(), repliedAt: minutesAgo(1).toISOString() },
      { via: "api" },
    );
    if (!done.ok) throw new Error(done.error);
    const r = await fireUser(asActor(t.lva), t.va.id);
    expect(r.ok && r.data).toEqual({ fired: 1, moved: 0, needAccount: 0 });
    const va = await db.user.findUniqueOrThrow({ where: { id: t.va.id } });
    expect(va.status).toBe("FIRED");
    expect(va.sessionVersion).toBe(1);
    expect((await db.trackingLink.findUniqueOrThrow({ where: { vaId: t.va.id } })).active).toBe(false);
    expect(await db.tgAccount.findUniqueOrThrow({ where: { id: t.account.id } })).toMatchObject({ status: "AVAILABLE", vaId: null });
    expect((await db.convo.findUniqueOrThrow({ where: { id: done.data.convoId } })).vaId).toBe(t.va.id);
  });

  it("who can fire whom", async () => {
    const t = await makeTeam();
    const otherLva = await makeUser("LEAD_VA", t.lm.id, t.model.id);
    expect((await fireUser(asActor(otherLva), t.va.id)).ok).toBe(false); // not their VA
    expect((await fireUser(asActor(t.lm), t.va.id)).ok).toBe(false); // LM fires Lead VAs, not VAs
    expect((await fireUser(asActor(t.va), t.va.id)).ok).toBe(false);
    expect((await fireUser(asActor(t.lm), t.director.id)).ok).toBe(false);
    expect((await fireUser(asActor(t.director), t.va.id)).ok).toBe(true); // Director: anyone
  });

  it("firing a Lead VA asks what to do with their VAs; 'fire them too' frees all their accounts", async () => {
    const t = await makeTeam();
    const plan = await planFire(asActor(t.lm), t.lva.id);
    expect(plan.ok && plan.data.under.map((u) => u.id)).toEqual([t.va.id]);
    const noChoice = await fireUser(asActor(t.lm), t.lva.id);
    expect(!noChoice.ok && noChoice.error).toMatch(/Choose what happens/);
    const r = await fireUser(asActor(t.lm), t.lva.id, { reports: "fire" });
    expect(r.ok && r.data).toEqual({ fired: 2, moved: 0, needAccount: 0 });
    expect(await db.user.count({ where: { status: "FIRED" } })).toBe(2);
    expect((await db.tgAccount.findUniqueOrThrow({ where: { id: t.account.id } })).status).toBe("AVAILABLE");
  });

  it("…or moves them to another Lead VA; to a team on another model they swap accounts", async () => {
    const t = await makeTeam();
    const B = await makeModel();
    const sameModel = await makeUser("LEAD_VA", t.lm.id, t.model.id);
    const r1 = await fireUser(asActor(t.lm), t.lva.id, { reports: { moveTo: sameModel.id } });
    expect(r1.ok && r1.data).toEqual({ fired: 1, moved: 1, needAccount: 0 });
    expect(await db.user.findUniqueOrThrow({ where: { id: t.va.id } })).toMatchObject({ parentId: sameModel.id, status: "ACTIVE" });
    expect((await accountOf(t.va.id))?.id).toBe(t.account.id); // same model: keeps the account

    const otherModelLva = await makeUser("LEAD_VA", t.lm.id, B.id);
    const bAcct = await makeAccount(B.id);
    const r2 = await fireUser(asActor(t.lm), sameModel.id, { reports: { moveTo: otherModelLva.id } });
    expect(r2.ok && r2.data).toMatchObject({ moved: 1, needAccount: 0 });
    expect((await accountOf(t.va.id))?.id).toBe(bAcct.id);
    expect((await db.user.findUniqueOrThrow({ where: { id: t.va.id } })).modelId).toBe(B.id);
  });

  it("firing a Lead Manager: move their Lead VAs to another Lead Manager, or fire everyone below", async () => {
    const t = await makeTeam();
    const lm2 = await makeUser("LEAD_MANAGER", t.director.id);
    const p = await planFire(asActor(t.director), t.lm.id);
    expect(p.ok && p.data).toMatchObject({ underTotal: 2 });
    const r = await fireUser(asActor(t.director), t.lm.id, { reports: { moveTo: lm2.id } });
    expect(r.ok && r.data).toMatchObject({ fired: 1, moved: 1 });
    expect((await db.user.findUniqueOrThrow({ where: { id: t.lva.id } })).parentId).toBe(lm2.id);

    const r2 = await fireUser(asActor(t.director), lm2.id, { reports: "fire" });
    expect(r2.ok && r2.data.fired).toBe(3); // LM + Lead VA + VA
    expect(await db.user.count({ where: { role: { not: "DIRECTOR" }, status: "ACTIVE" } })).toBe(0); // both LMs, the Lead VA and the VA
  });

  it("a freed account goes straight to a VA who was waiting for one", async () => {
    const t = await makeTeam();
    const waiting = await makeUser("VA", t.lva.id, t.model.id);
    await db.user.update({ where: { id: waiting.id }, data: { telegramUserId: BigInt(424242) } });
    await fireUser(asActor(t.lva), t.va.id);
    expect((await accountOf(waiting.id))?.id).toBe(t.account.id);
    expect(sent.some((s) => s.to === BigInt(424242))).toBe(true);
  });

  it("bulk 'fire inactive VAs': lists, then fires only those still inactive", async () => {
    const t = await makeTeam(); // VA hired 1h ago → too new, not listed
    const old = { idle: await makeUser("VA", t.lva.id, t.model.id), busy: await makeUser("VA", t.lva.id, t.model.id) };
    const tenDaysAgo = new Date(Date.now() - 10 * 86400_000);
    await db.user.updateMany({ where: { id: { in: [old.idle.id, old.busy.id] } }, data: { createdAt: tenDaysAgo } });
    const bAcct = await makeAccount(t.model.id);
    await assign(bAcct.id, old.busy.id, tenDaysAgo);
    const q = await ingestConvoEvent(
      { tgAccount: bAcct.username, peerId: "x", peerPhone: "+14155550100", firstMsgAt: minutesAgo(9).toISOString(), repliedAt: minutesAgo(8).toISOString() },
      { via: "api" },
    );
    if (!q.ok || q.data.status !== "QUALIFIED") throw new Error("setup");

    const list = await findInactiveVas(asActor(t.lva), 7);
    expect(list.ok && list.data.map((v) => v.id)).toEqual([old.idle.id]);
    const otherLva = await makeUser("LEAD_VA", t.lm.id, t.model.id);
    expect(await findInactiveVas(asActor(otherLva), 7)).toEqual({ ok: true, data: [] }); // only their own team

    const r = await fireInactiveVas(asActor(t.lva), 7, [old.idle.id, old.busy.id]);
    expect(r.ok && r.data).toEqual({ fired: 1, skipped: 1 }); // busy one isn't inactive
    expect((await db.user.findUniqueOrThrow({ where: { id: old.idle.id } })).status).toBe("FIRED");
  });
});

describe("5. re-adding fired people", () => {
  it("creating a fired Lead VA's handle again reactivates the same login under the new manager", async () => {
    const t = await makeTeam();
    const made = await createManagedUser(asActor(t.lm), { role: "LEAD_VA", handle: "comeback_kid", modelId: t.model.id });
    if (!made.ok) throw new Error(made.error);
    const lva = await db.user.findUniqueOrThrow({ where: { username: made.data.username } });
    await fireUser(asActor(t.lm), lva.id);

    const lm2 = await makeUser("LEAD_MANAGER", t.director.id);
    const again = await createManagedUser(asActor(lm2), { role: "LEAD_VA", handle: "@COMEBACK_KID", modelId: t.model.id });
    expect(again.ok && again.data).toMatchObject({ username: made.data.username, reactivated: true });
    expect(await db.user.findUniqueOrThrow({ where: { id: lva.id } })).toMatchObject({ status: "ACTIVE", parentId: lm2.id, firedAt: null });
    expect(await db.user.count({ where: { username: { equals: made.data.username, mode: "insensitive" } } })).toBe(1);
  });

  it("an active person's handle is still taken; a fired Lead Manager comes back too", async () => {
    const t = await makeTeam();
    const made = await createManagedUser(asActor(t.director), { role: "LEAD_MANAGER", handle: "boss_person" });
    if (!made.ok) throw new Error(made.error);
    expect((await createManagedUser(asActor(t.director), { role: "LEAD_MANAGER", handle: "boss_person" })).ok).toBe(false);
    await fireUser(asActor(t.director), (await db.user.findUniqueOrThrow({ where: { username: made.data.username } })).id);
    const back = await createManagedUser(asActor(t.director), { role: "LEAD_MANAGER", handle: "boss_person" });
    expect(back.ok && back.data.reactivated).toBe(true);
  });
});
