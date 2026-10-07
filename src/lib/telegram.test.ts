import { describe, expect, it } from "vitest";
import { normalizeHandle, telegramChatUrl } from "./telegram";

describe("normalizeHandle", () => {
  it("strips @ and whitespace", () => {
    expect(normalizeHandle("  @Support_Team ")).toBe("Support_Team");
  });

  it("rejects invalid handles", () => {
    for (const bad of ["", "@", "abcd", "1abcde", "has space", "a".repeat(33), "evil.com/x", "x?y=1"]) {
      expect(normalizeHandle(bad)).toBeNull();
    }
  });
});

describe("telegramChatUrl", () => {
  it("builds a t.me link only for valid handles", () => {
    expect(telegramChatUrl("@helpdesk")).toBe("https://t.me/helpdesk");
    expect(telegramChatUrl("")).toBeNull();
  });
});
