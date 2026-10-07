import { describe, expect, it } from "vitest";
import { centsToDollars, formatCents, parseDollarsToCents } from "./money";

describe("parseDollarsToCents", () => {
  it("converts exactly, without float error", () => {
    expect(parseDollarsToCents("0.25")).toBe(25);
    expect(parseDollarsToCents("0.1")).toBe(10);
    expect(parseDollarsToCents("1")).toBe(100);
    expect(parseDollarsToCents("$1.5")).toBe(150);
    expect(parseDollarsToCents("0.29")).toBe(29); // 0.29 * 100 = 28.999… as a float
    expect(parseDollarsToCents("0")).toBe(0);
  });

  it("rejects negatives, extra decimals and junk", () => {
    for (const bad of ["-1", "0.255", "abc", "", "1e2", "1,5", ".5"]) expect(parseDollarsToCents(bad)).toBeNull();
  });
});

describe("centsToDollars / formatCents", () => {
  it("formats with two decimals", () => {
    expect(centsToDollars(25)).toBe("0.25");
    expect(centsToDollars(150)).toBe("1.50");
    expect(centsToDollars(0)).toBe("0.00");
    expect(formatCents(1234)).toBe("$12.34");
  });

  it("refuses non-integer cents", () => {
    expect(() => centsToDollars(1.5)).toThrow();
  });
});
