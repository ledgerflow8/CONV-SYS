import { describe, expect, it } from "vitest";
import { cleanPassword, cleanUsername, suffixCandidates } from "./credentials";
import { generatePassword } from "./password";

describe("cleanUsername", () => {
  it("removes @, spaces and invisible characters", () => {
    expect(cleanUsername(" @Teddyalte_LM ")).toBe("Teddyalte_LM");
    expect(cleanUsername("@@kemi_promo_VA​")).toBe("kemi_promo_VA");
    expect(cleanUsername("﻿director\n")).toBe("director");
  });
});

describe("cleanPassword", () => {
  it("removes whitespace and invisible characters picked up by copy-paste", () => {
    expect(cleanPassword("aB3dE5gH7jK9 ")).toBe("aB3dE5gH7jK9");
    expect(cleanPassword("aB3dE5gH7jK9\n")).toBe("aB3dE5gH7jK9");
    expect(cleanPassword("aB3d​E5gH7jK9")).toBe("aB3dE5gH7jK9");
    expect(cleanPassword(" aB3d E5gH7jK9 ")).toBe("aB3dE5gH7jK9");
  });

  it("never changes a password the portal generates", () => {
    for (let i = 0; i < 500; i++) {
      const p = generatePassword(16);
      expect(cleanPassword(p)).toBe(p);
    }
  });
});

describe("suffixCandidates", () => {
  it("offers the role suffixes for a bare Telegram handle", () => {
    expect(suffixCandidates("Teddyalte")).toEqual(["Teddyalte_LM", "Teddyalte_LVA", "Teddyalte_VA"]);
  });

  it("offers nothing when a suffix is already there", () => {
    expect(suffixCandidates("Teddyalte_LM")).toEqual([]);
    expect(suffixCandidates("kemi_promo_va")).toEqual([]);
  });
});
