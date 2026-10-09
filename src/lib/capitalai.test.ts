import { describe, expect, it } from "vitest";
import { normalizeAccountId, toConvoEvent, type Conversation } from "./capitalai";

const conv = (transcript: Conversation["transcript"]): Conversation => ({
  conversation: { id: 1, identifier: "u123", accountId: "Sophie_TG01" },
  transcript,
});

describe("toConvoEvent", () => {
  it("fan writes first: firstMsgAt = fan's first message, repliedAt = account's first reply after it", () => {
    const e = toConvoEvent(
      conv([
        { role: "user", content: "hi", timestamp: "2026-10-07T10:00:00.000Z" },
        { role: "user", content: "u there?", timestamp: "2026-10-07T10:01:00.000Z" },
        { role: "assistant", content: "hey", timestamp: "2026-10-07T10:05:00.000Z" },
      ]),
      "sophie_tg01",
    );
    expect(e).toEqual({ tgAccount: "sophie_tg01", peerId: "u123", firstMsgAt: "2026-10-07T10:00:00.000Z", repliedAt: "2026-10-07T10:05:00.000Z" });
  });

  it("AI opener first: the opener isn't the reply; the first account message after the fan's is", () => {
    const e = toConvoEvent(
      conv([
        { role: "assistant", content: "heyy", timestamp: "2026-10-07T09:00:00.000Z" },
        { role: "user", content: "who is this", timestamp: "2026-10-07T09:30:00.000Z" },
        { role: "bot", content: "megan :)", timestamp: "2026-10-07T09:31:00.000Z" },
      ]),
      "x",
    );
    expect(e?.firstMsgAt).toBe("2026-10-07T09:30:00.000Z");
    expect(e?.repliedAt).toBe("2026-10-07T09:31:00.000Z");
  });

  it("no reply yet → no repliedAt (stays PENDING in ingest)", () => {
    expect(toConvoEvent(conv([{ role: "user", timestamp: "2026-10-07T10:00:00.000Z" }]), "x")?.repliedAt).toBeUndefined();
  });

  it("fan never wrote → null; null/garbage timestamps are ignored; order is by time, not array position", () => {
    expect(toConvoEvent(conv([{ role: "assistant", timestamp: "2026-10-07T09:00:00.000Z" }]), "x")).toBeNull();
    const e = toConvoEvent(
      conv([
        { role: "assistant", timestamp: "2026-10-07T10:05:00.000Z" },
        { role: "user", timestamp: null },
        { role: "user", timestamp: "not a date" },
        { role: "User", timestamp: "2026-10-07T10:00:00.000Z" },
      ]),
      "x",
    );
    expect(e).toMatchObject({ firstMsgAt: "2026-10-07T10:00:00.000Z", repliedAt: "2026-10-07T10:05:00.000Z" });
  });
});

describe("normalizeAccountId", () => {
  it("matches our pool's lowercase usernames", () => {
    expect(normalizeAccountId(" @Sophie_TG01 ")).toBe("sophie_tg01");
  });
});
