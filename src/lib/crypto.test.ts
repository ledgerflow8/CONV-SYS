import { beforeAll, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { decrypt, encrypt, hashToken, newInviteToken, randomSlug } from "./crypto";

beforeAll(() => {
  process.env.ENCRYPTION_KEY = randomBytes(32).toString("base64");
});

describe("encrypt/decrypt", () => {
  it("round-trips and uses a fresh IV each time", () => {
    const a = encrypt("hunter2");
    const b = encrypt("hunter2");
    expect(a).not.toBe(b);
    expect(a).not.toContain("hunter2");
    expect(decrypt(a)).toBe("hunter2");
  });

  it("rejects tampered ciphertext", () => {
    const [v, iv, tag, ct] = encrypt("hunter2").split(".");
    const flipped = Buffer.from(ct, "base64url");
    flipped[0] ^= 1;
    expect(() => decrypt([v, iv, tag, flipped.toString("base64url")].join("."))).toThrow();
  });

  it("fails loudly with a wrong-size key", () => {
    const saved = process.env.ENCRYPTION_KEY;
    process.env.ENCRYPTION_KEY = "short";
    expect(() => encrypt("x")).toThrow(/ENCRYPTION_KEY/);
    process.env.ENCRYPTION_KEY = saved;
  });
});

describe("invite tokens", () => {
  it("fit Telegram's /start payload rules", () => {
    const t = newInviteToken();
    expect(t).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
    expect(hashToken(t)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashToken(t)).not.toBe(t);
  });

  it("slugs are url-safe", () => {
    expect(randomSlug()).toMatch(/^[a-z2-9]{10}$/);
  });
});
