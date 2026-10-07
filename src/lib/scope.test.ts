import { describe, expect, it } from "vitest";
import { scopeFor } from "./scope";

const u = (role: "DIRECTOR" | "LEAD_MANAGER" | "LEAD_VA" | "VA", modelId: string | null = null) => ({
  id: "me",
  role,
  modelId,
});

describe("scopeFor", () => {
  it("Director sees everything", () => {
    expect(scopeFor(u("DIRECTOR"))).toEqual({ convo: {}, user: {}, tgAccount: {}, payout: {} });
  });

  it("scopes convos by the snapshotted id for each role", () => {
    expect(scopeFor(u("LEAD_MANAGER")).convo).toEqual({ leadManagerId: "me" });
    expect(scopeFor(u("LEAD_VA", "m1")).convo).toEqual({ leadVaId: "me" });
    expect(scopeFor(u("VA")).convo).toEqual({ vaId: "me" });
  });

  it("VA only sees themselves, their accounts and payouts", () => {
    const s = scopeFor(u("VA"));
    expect(s.user).toEqual({ id: "me" });
    expect(s.tgAccount).toEqual({ vaId: "me" });
    expect(s.payout).toEqual({ userId: "me" });
  });

  it("non-Director scopes are never empty filters", () => {
    for (const role of ["LEAD_MANAGER", "LEAD_VA", "VA"] as const) {
      const s = scopeFor(u(role, "m1"));
      for (const where of Object.values(s)) expect(where).not.toEqual({});
    }
  });

  it("Lead VA without a model does not see the whole available pool", () => {
    const s = scopeFor(u("LEAD_VA", null));
    const branches = (s.tgAccount.OR ?? []) as object[];
    expect(branches).not.toContainEqual({ status: "AVAILABLE", modelId: null });
    expect(branches).not.toContainEqual(expect.objectContaining({ modelId: undefined }));
    expect(branches).toContainEqual({ id: { in: [] } });
  });
});
