import { describe, expect, it } from "vitest";
import { signIngestBody, verifyIngestRequest } from "./ingest-auth";

const cfg = { apiKey: "key_live_abc", hmacSecret: "shh" };
const now = 1_790_000_000;
const body = '{"tgAccount":"a","peerId":"1","firstMsgAt":"2026-10-07T10:00:00Z"}';

function req(over: Record<string, string> = {}, b = body) {
  const ts = over["x-timestamp"] ?? String(now);
  return new Headers({
    authorization: "Bearer key_live_abc",
    "x-timestamp": ts,
    "x-signature": signIngestBody("shh", ts, b),
    ...over,
  });
}

describe("verifyIngestRequest", () => {
  it("accepts a correctly signed request", () => {
    expect(verifyIngestRequest(req(), body, cfg, now)).toEqual({ ok: true });
  });

  it("rejects a wrong or missing API key", () => {
    expect(verifyIngestRequest(req({ authorization: "Bearer nope" }), body, cfg, now).ok).toBe(false);
    expect(verifyIngestRequest(req({ authorization: "" }), body, cfg, now).ok).toBe(false);
  });

  it("rejects a tampered body", () => {
    expect(verifyIngestRequest(req(), body.replace('"1"', '"2"'), cfg, now)).toEqual({ ok: false, error: "invalid signature" });
  });

  it("rejects a signature made with another secret", () => {
    const h = req({ "x-signature": signIngestBody("other", String(now), body) });
    expect(verifyIngestRequest(h, body, cfg, now).ok).toBe(false);
  });

  it("rejects replays outside the 5-minute window, and malformed timestamps", () => {
    const old = String(now - 301);
    expect(verifyIngestRequest(req({ "x-timestamp": old }), body, cfg, now).ok).toBe(false);
    expect(verifyIngestRequest(req({ "x-timestamp": "abc" }), body, cfg, now).ok).toBe(false);
    expect(verifyIngestRequest(req({ "x-timestamp": String(now - 299) }), body, cfg, now).ok).toBe(true);
  });
});
