import { describe, expect, it } from "vitest";
import { normalizeTxHash, normalizeWallet, shortWallet } from "./wallet";

const W = "0x52908400098527886E0F7030069857D2E4169EE7";

describe("normalizeWallet", () => {
  it("accepts 0x + 40 hex in any case, trimmed", () => {
    expect(normalizeWallet(`  ${W} `)).toBe(W);
    expect(normalizeWallet(W.toLowerCase())).toBe(W.toLowerCase());
  });

  it("rejects wrong length, missing 0x, non-hex and other chains' formats", () => {
    for (const bad of ["", W.slice(0, 41), `${W}0`, W.slice(2), "0xZZ908400098527886E0F7030069857D2E4169EE7", "TQ1j9tYJ5cNk1ZcBAz5u5hX4Nn1vY6Wn8e"]) {
      expect(normalizeWallet(bad)).toBeNull();
    }
  });
});

describe("normalizeTxHash", () => {
  it("accepts 64 hex with or without 0x", () => {
    const h = "a".repeat(64);
    expect(normalizeTxHash(h)).toBe(h);
    expect(normalizeTxHash(`0x${h}`)).toBe(`0x${h}`);
  });

  it("rejects anything else", () => {
    expect(normalizeTxHash("a".repeat(63))).toBeNull();
    expect(normalizeTxHash("g".repeat(64))).toBeNull();
  });
});

it("shortWallet", () => {
  expect(shortWallet(W)).toBe("0x5290…9EE7");
});
