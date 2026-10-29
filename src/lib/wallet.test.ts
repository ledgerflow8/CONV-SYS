import { describe, expect, it } from "vitest";
import { checkWallet, isAptosAddress, normalizeTxHash, normalizeWallet, shortWallet } from "./wallet";

const APTOS = "0x9f3a6c1e5b7d4e8a9c217d4e5f6a8b90c3d2e1f0a9b8c7d6e5f4a3b2c1d0e9f8";
const EVM = "0x52908400098527886E0F7030069857D2E4169EE7";

describe("normalizeWallet (Aptos)", () => {
  it("accepts 0x + 64 hex in any case, trimmed, stored lowercase", () => {
    expect(normalizeWallet(`  ${APTOS} `)).toBe(APTOS);
    expect(normalizeWallet(APTOS.toUpperCase().replace("0X", "0x"))).toBe(APTOS);
  });

  it("accepts the short form and left-pads it to 64", () => {
    const short = "0x3a6c1e5b7d4e8a9c217d4e5f6a8b90c3d2e1f0a9b8c7d6e5f4a3b2c1d0e9f8"; // leading zeros dropped (62 hex)
    expect(normalizeWallet(short)).toBe(`0x00${short.slice(2)}`);
    expect(normalizeWallet(short)).toHaveLength(66);
    expect(normalizeWallet("0xABC123")).toBe(`0x${"abc123".padStart(64, "0")}`);
  });

  it("refuses an old Ethereum-style address instead of padding it into a stranger's Aptos account", () => {
    const r = checkWallet(EVM);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toMatch(/Ethereum-style/);
    expect(normalizeWallet(EVM.toLowerCase())).toBeNull();
  });

  it("refuses Aptos's reserved system addresses", () => {
    for (const sys of ["0x1", "0x0", "0xf", `0x${"0".repeat(63)}1`]) {
      const r = checkWallet(sys);
      expect(!r.ok && r.error).toMatch(/reserved/);
    }
    expect(normalizeWallet("0x10")).toBe(`0x${"10".padStart(64, "0")}`); // 0x10 and up are ordinary
  });

  it("rejects missing 0x, too long, non-hex and other chains' formats", () => {
    for (const bad of ["", "0x", APTOS.slice(2), `${APTOS}0`, `0x${"g".repeat(64)}`, "TQ1j9tYJ5cNk1ZcBAz5u5hX4Nn1vY6Wn8e", "0x 9f3a"]) {
      expect(normalizeWallet(bad)).toBeNull();
    }
  });

  it("isAptosAddress: only stored Aptos addresses, never pre-move EVM ones", () => {
    expect(isAptosAddress(APTOS)).toBe(true);
    expect(isAptosAddress(EVM)).toBe(false);
    expect(isAptosAddress(APTOS.toUpperCase())).toBe(false); // stored form is lowercase
    expect(isAptosAddress(null)).toBe(false);
  });
});

describe("normalizeTxHash", () => {
  it("accepts 64 hex with or without 0x (Aptos tx hashes are 0x + 64)", () => {
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
  expect(shortWallet(APTOS)).toBe("0x9f3a…e9f8");
});
