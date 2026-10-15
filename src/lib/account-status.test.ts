import { describe, expect, it } from "vitest";
import { accountStatusSchema } from "./account-status";

describe("accountStatusSchema", () => {
  it("accepts a well-formed event and parses the date", () => {
    const r = accountStatusSchema.safeParse({ tgAccount: "sophie", status: "banned", at: "2026-10-16T09:00:00Z" });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.at).toBeInstanceOf(Date);
  });

  it("rejects an unknown status and a zoneless date", () => {
    expect(accountStatusSchema.safeParse({ tgAccount: "a", status: "weird", at: "2026-10-16T09:00:00Z" }).success).toBe(false);
    expect(accountStatusSchema.safeParse({ tgAccount: "a", status: "online", at: "2026-10-16 09:00" }).success).toBe(false);
  });
});
