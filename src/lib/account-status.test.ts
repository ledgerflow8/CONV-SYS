import { describe, expect, it } from "vitest";
import { accountRenameSchema, accountStatusSchema } from "./account-status";

describe("accountStatusSchema", () => {
  it("accepts a well-formed event and parses the date", () => {
    const r = accountStatusSchema.safeParse({ tgAccount: "sophie", status: "banned", at: "2026-10-16T09:00:00Z" });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.at).toBeInstanceOf(Date);
  });

  it("accepts an optional numeric tgUserId", () => {
    const r = accountStatusSchema.safeParse({ tgAccount: "a", tgUserId: "6001", status: "online", at: "2026-10-16T09:00:00Z" });
    expect(r.success).toBe(true);
    expect(accountStatusSchema.safeParse({ tgAccount: "a", tgUserId: "not-a-number", status: "online", at: "2026-10-16T09:00:00Z" }).success).toBe(false);
  });

  it("rejects an unknown status and a zoneless date", () => {
    expect(accountStatusSchema.safeParse({ tgAccount: "a", status: "weird", at: "2026-10-16T09:00:00Z" }).success).toBe(false);
    expect(accountStatusSchema.safeParse({ tgAccount: "a", status: "online", at: "2026-10-16 09:00" }).success).toBe(false);
  });
});

describe("accountRenameSchema", () => {
  it("requires tgUserId and a valid new username", () => {
    const ok = accountRenameSchema.safeParse({ tgUserId: "6004", oldUsername: "old", newUsername: "newname", at: "2026-10-16T09:00:00Z" });
    expect(ok.success).toBe(true);
    expect(accountRenameSchema.safeParse({ oldUsername: "old", newUsername: "newname", at: "2026-10-16T09:00:00Z" }).success).toBe(false); // no id
    expect(accountRenameSchema.safeParse({ tgUserId: "6004", newUsername: "no", at: "2026-10-16T09:00:00Z" }).success).toBe(false); // too short
    expect(accountRenameSchema.safeParse({ tgUserId: "6004", newUsername: "bad name!", at: "2026-10-16T09:00:00Z" }).success).toBe(false); // bad chars
  });
});
