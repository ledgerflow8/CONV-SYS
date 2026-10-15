import { beforeEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { recordAccountStatus } from "@/lib/account-status";
import { makeAccount, makeModel, resetDb } from "../../test/fixtures";

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
