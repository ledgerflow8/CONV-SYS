import { describe, expect, it } from "vitest";
import { countryFromPhone, decide, isFinal, type DecisionInput } from "./qualify";

const TIER1 = ["US", "CA", "GB", "AU", "NZ", "IE"];
const base: DecisionInput = {
  accountKnown: true,
  attributed: true,
  country: "US",
  tier1: TIER1,
  blockedSource: false,
  replied: true,
};

describe("decide", () => {
  it("qualifies a replied, attributed Tier 1 convo from a clean source", () => {
    expect(decide(base)).toEqual({ status: "QUALIFIED" });
  });

  it("unknown account goes to review before anything else", () => {
    expect(decide({ ...base, accountKnown: false, country: "NG", blockedSource: true })).toEqual({
      status: "REVIEW",
      reviewReason: "unknown_account",
    });
  });

  it("known non-Tier-1 country is rejected, even before a reply", () => {
    expect(decide({ ...base, country: "NG", replied: false })).toEqual({ status: "REJECTED", rejectReason: "non_tier1" });
  });

  it("blocked source is rejected", () => {
    expect(decide({ ...base, blockedSource: true })).toEqual({ status: "REJECTED", rejectReason: "blocked_source" });
  });

  it("no reply yet stays pending, even with unknown country", () => {
    expect(decide({ ...base, replied: false })).toEqual({ status: "PENDING" });
    expect(decide({ ...base, replied: false, country: null })).toEqual({ status: "PENDING" });
  });

  it("no VA held the account → review", () => {
    expect(decide({ ...base, attributed: false })).toEqual({ status: "REVIEW", reviewReason: "unattributed" });
  });

  it("unknown country → review (PLAN.md §9 default)", () => {
    expect(decide({ ...base, country: null })).toEqual({ status: "REVIEW", reviewReason: "unknown_country" });
  });

  it("uses the configured Tier 1 list, not a hard-coded one", () => {
    expect(decide({ ...base, country: "DE", tier1: [...TIER1, "DE"] })).toEqual({ status: "QUALIFIED" });
  });
});

describe("isFinal", () => {
  it("only QUALIFIED and REJECTED are final", () => {
    expect(isFinal("QUALIFIED")).toBe(true);
    expect(isFinal("REJECTED")).toBe(true);
    expect(isFinal("PENDING")).toBe(false);
    expect(isFinal("REVIEW")).toBe(false);
  });
});

describe("countryFromPhone", () => {
  it("resolves country from the prefix", () => {
    expect(countryFromPhone("+1 415 555 0100")).toBe("US");
    expect(countryFromPhone("+44 7400 123456")).toBe("GB");
    expect(countryFromPhone("+1 416 555 0100")).toBe("CA");
    expect(countryFromPhone("+234 803 123 4567")).toBe("NG");
    expect(countryFromPhone("447400123456")).toBe("GB"); // missing +
  });

  it("shared +44 ranges resolve to the Crown Dependency, not GB", () => {
    // Guernsey mobile range. Not Tier 1 by default — the Director can add GG/JE/IM.
    expect(countryFromPhone("+44 7911 123456")).toBe("GG");
  });

  it("doesn't guess a country for numbers it can't place", () => {
    expect(countryFromPhone("+44 7700 900123")).toBeNull(); // Ofcom fictional range
  });

  it("returns null for junk", () => {
    expect(countryFromPhone(null)).toBeNull();
    expect(countryFromPhone("")).toBeNull();
    expect(countryFromPhone("12")).toBeNull();
  });
});
