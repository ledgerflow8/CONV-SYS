import { beforeEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { recordAccountStatus, registerAccount, renameAccount, retireAccount } from "@/lib/account-status";
import { claimAvailableAccount } from "@/lib/team";
import { makeAccount, makeModel, makeTeam, resetDb } from "../../test/fixtures";

beforeEach(resetDb);

describe("recordAccountStatus (record-only)", () => {
  it("stores panelStatus/lastSeenAt and leaves TgStatus and the holder untouched", async () => {
    const model = await makeModel();
    const acc = await makeAccount(model.id);
    const r = await recordAccountStatus({ tgAccount: `@${acc.username.toUpperCase()}`, status: "banned", at: new Date().toISOString() });
    expect(r).toEqual({ ok: true, data: { recorded: true } });

    const after = await db.tgAccount.findUniqueOrThrow({ where: { id: acc.id } });
    expect(after.panelStatus).toBe("banned");
    expect(after.lastSeenAt).toBeInstanceOf(Date);
    expect(after.status).toBe("AVAILABLE"); // billing status is never changed by the beacon
    expect(after.vaId).toBeNull();
  });

  it("acknowledges an unknown account instead of failing it", async () => {
    const r = await recordAccountStatus({ tgAccount: "nobody", status: "online", at: new Date().toISOString() });
    expect(r).toEqual({ ok: true, data: { recorded: false, reason: "unknown_account" } });
  });

  it("ignores a report older than the last one seen", async () => {
    const model = await makeModel();
    const acc = await makeAccount(model.id);
    const newer = new Date();
    const older = new Date(newer.getTime() - 60_000);
    await recordAccountStatus({ tgAccount: acc.username, status: "online", at: newer.toISOString() });
    const r = await recordAccountStatus({ tgAccount: acc.username, status: "offline", at: older.toISOString() });
    expect(r.ok && r.data.recorded).toBe(false);
    const after = await db.tgAccount.findUniqueOrThrow({ where: { id: acc.id } });
    expect(after.panelStatus).toBe("online");
  });

  it("rejects a malformed event", async () => {
    const r = await recordAccountStatus({ tgAccount: "", status: "online", at: "nope" });
    expect(r.ok).toBe(false);
  });
});

describe("renameAccount + numeric-id matching (username changes from the panel)", () => {
  it("renames the account and moves its t.me link, found by numeric id", async () => {
    const model = await makeModel();
    const acc = await makeAccount(model.id);
    await db.tgAccount.update({ where: { id: acc.id }, data: { tgUserId: BigInt(6004) } });

    const r = await renameAccount({ tgUserId: "6004", oldUsername: acc.username, newUsername: "SophieNew", at: new Date().toISOString() });
    expect(r).toEqual({ ok: true, data: { recorded: true } });

    const after = await db.tgAccount.findUniqueOrThrow({ where: { id: acc.id } });
    expect(after.username).toBe("sophienew");
    expect(after.link).toBe("https://t.me/sophienew");
  });

  it("the assigned VA still holds the account after a rename (tracking link follows the account)", async () => {
    const t = await makeTeam();
    await db.tgAccount.update({ where: { id: t.account.id }, data: { tgUserId: BigInt(7777) } });

    await renameAccount({ tgUserId: "7777", oldUsername: t.account.username, newUsername: "renamed99", at: new Date().toISOString() });

    const after = await db.tgAccount.findUniqueOrThrow({ where: { id: t.account.id } });
    expect(after.username).toBe("renamed99");
    expect(after.vaId).toBe(t.va.id); // same holder → the VA's tracking link + dashboard follow
    const link = await db.trackingLink.findUniqueOrThrow({ where: { vaId: t.va.id } });
    expect(link.id).toBe(t.link.id);
  });

  it("falls back to the old username and backfills the numeric id when it isn't stored yet", async () => {
    const model = await makeModel();
    const acc = await makeAccount(model.id); // no tgUserId yet
    const r = await renameAccount({ tgUserId: "8008", oldUsername: acc.username, newUsername: "freshname", at: new Date().toISOString() });
    expect(r.ok && r.data.recorded).toBe(true);
    const after = await db.tgAccount.findUniqueOrThrow({ where: { id: acc.id } });
    expect(after.username).toBe("freshname");
    expect(after.tgUserId).toBe(BigInt(8008)); // backfilled via the fallback match
  });

  it("acknowledges a rename for an unknown account", async () => {
    const r = await renameAccount({ tgUserId: "9999", oldUsername: "ghost", newUsername: "whoever1", at: new Date().toISOString() });
    expect(r).toEqual({ ok: true, data: { recorded: false, reason: "unknown_account" } });
  });

  it("a status report matches by numeric id even after the username changed, and backfills it", async () => {
    const model = await makeModel();
    const acc = await makeAccount(model.id); // stored username = acc.username, tgUserId = null
    // The panel now reports under a NEW username but the same numeric id.
    const r = await recordAccountStatus({ tgAccount: "a-name-we-dont-store", tgUserId: String(1234), status: "online", at: new Date().toISOString() });
    // Unknown by that made-up username and the id isn't stored → acknowledged, not matched.
    expect(r.ok && r.data.recorded).toBe(false);

    // But once the id is known, a report under any username lands on the right account.
    await db.tgAccount.update({ where: { id: acc.id }, data: { tgUserId: BigInt(1234) } });
    const r2 = await recordAccountStatus({ tgAccount: "still-a-different-name", tgUserId: "1234", status: "limited", at: new Date().toISOString() });
    expect(r2.ok && r2.data.recorded).toBe(true);
    const after = await db.tgAccount.findUniqueOrThrow({ where: { id: acc.id } });
    expect(after.panelStatus).toBe("limited");
  });
});

describe("registerAccount / retireAccount (portal pool auto-sync)", () => {
  it("creates an unassigned account keyed by numeric id", async () => {
    const r = await registerAccount({ action: "register", tgUserId: "5005", username: "NewAcct", phone: "+13095550123", link: "https://t.me/newacct" });
    expect(r).toEqual({ ok: true, data: { recorded: true } });
    const acc = await db.tgAccount.findFirstOrThrow({ where: { tgUserId: BigInt(5005) } });
    expect(acc.modelId).toBeNull(); // unassigned until a Director sets it
    expect(acc.username).toBe("newacct");
    expect(acc.status).toBe("AVAILABLE");
  });

  it("registers a no-username account and keeps it out of the claimable pool", async () => {
    const model = await makeModel();
    await registerAccount({ action: "register", tgUserId: "5006", username: null, phone: "+1" });
    const acc = await db.tgAccount.findFirstOrThrow({ where: { tgUserId: BigInt(5006) } });
    expect(acc.username).toBeNull();
    // Even once a model is set, a null-username AVAILABLE account is never claimed.
    await db.tgAccount.update({ where: { id: acc.id }, data: { modelId: model.id } });
    const claimed = await claimAvailableAccount(db, model.id);
    expect(claimed).toBeNull();
  });

  it("refreshes an existing account without touching its model or holder", async () => {
    const t = await makeTeam(); // assigned account, has a model + holder
    await db.tgAccount.update({ where: { id: t.account.id }, data: { tgUserId: BigInt(5007) } });
    await registerAccount({ action: "register", tgUserId: "5007", username: "movedname", phone: "+1999", link: "https://t.me/movedname" });
    const acc = await db.tgAccount.findUniqueOrThrow({ where: { id: t.account.id } });
    expect(acc.username).toBe("movedname");
    expect(acc.modelId).toBe(t.model.id); // unchanged
    expect(acc.vaId).toBe(t.va.id); // holder unchanged
    expect(acc.status).toBe("ASSIGNED");
  });

  it("retires an account and releases its holder", async () => {
    const t = await makeTeam();
    await db.tgAccount.update({ where: { id: t.account.id }, data: { tgUserId: BigInt(5008) } });
    const r = await retireAccount({ action: "retire", tgUserId: "5008" });
    expect(r.ok && r.data.recorded).toBe(true);
    const acc = await db.tgAccount.findUniqueOrThrow({ where: { id: t.account.id } });
    expect(acc.status).toBe("RETIRED");
    expect(acc.vaId).toBeNull();
    const open = await db.tgAssignment.findFirst({ where: { tgAccountId: t.account.id, endedAt: null } });
    expect(open).toBeNull(); // the assignment was closed
  });
});
