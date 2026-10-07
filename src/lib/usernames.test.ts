import { describe, expect, it } from "vitest";
import { portalUsername } from "./usernames";

describe("portalUsername", () => {
  it("adds the role suffix to a valid handle", () => {
    expect(portalUsername("@didi_nimi", "LEAD_VA")).toBe("didi_nimi_LVA");
    expect(portalUsername("bossman", "LEAD_MANAGER")).toBe("bossman_LM");
    expect(portalUsername("@kemi_promo", "VA")).toBe("kemi_promo_VA");
  });

  it("rejects short handles and roles without a suffix rule", () => {
    expect(portalUsername("abcd", "LEAD_VA")).toBeNull();
    expect(portalUsername("didi_nimi", "DIRECTOR")).toBeNull();
  });
});
