// Auth for POST /api/ingest/convo: API key + HMAC signature over timestamp and raw body.
//
//   Authorization: Bearer <INGEST_API_KEY>
//   X-Timestamp:   <unix seconds>
//   X-Signature:   sha256=<hex HMAC-SHA256(INGEST_HMAC_SECRET, "<timestamp>.<raw body>")>
//
// The timestamp must be within 5 minutes, so a captured request can't be replayed later.
import { createHmac, timingSafeEqual } from "node:crypto";

export const MAX_SKEW_SEC = 300;

type Headers = { get(name: string): string | null };

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export function signIngestBody(secret: string, timestamp: string, body: string): string {
  return `sha256=${createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex")}`;
}

export function verifyIngestRequest(
  headers: Headers,
  body: string,
  config: { apiKey: string; hmacSecret: string },
  nowSec = Math.floor(Date.now() / 1000),
): { ok: true } | { ok: false; error: string } {
  const auth = headers.get("authorization") ?? "";
  const key = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
  if (!key || !safeEqual(key, config.apiKey)) return { ok: false, error: "invalid API key" };

  const ts = headers.get("x-timestamp") ?? "";
  if (!/^\d{9,11}$/.test(ts)) return { ok: false, error: "missing or malformed X-Timestamp" };
  if (Math.abs(nowSec - Number(ts)) > MAX_SKEW_SEC) return { ok: false, error: "X-Timestamp too far from server time" };

  const sig = headers.get("x-signature") ?? "";
  if (!safeEqual(sig, signIngestBody(config.hmacSecret, ts, body))) return { ok: false, error: "invalid signature" };
  return { ok: true };
}
