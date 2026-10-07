// POST /api/ingest/convo — where the client's AI API posts convo events (PLAN.md §4).
// Body: one event, or { "events": [ ... ] } (max 500). Each event goes through ingestConvoEvent.
// Auth: see src/lib/ingest-auth.ts.
import { ingestConvoEvent } from "@/lib/ingest";
import { verifyIngestRequest } from "@/lib/ingest-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BODY_BYTES = 1_000_000;
const MAX_EVENTS = 500;

const json = (status: number, body: unknown) => Response.json(body, { status, headers: { "Cache-Control": "no-store" } });

export async function POST(req: Request) {
  const apiKey = process.env.INGEST_API_KEY;
  const hmacSecret = process.env.INGEST_HMAC_SECRET;
  if (!apiKey || !hmacSecret) return json(503, { error: "ingest not configured" });

  if (Number(req.headers.get("content-length") ?? 0) > MAX_BODY_BYTES) return json(413, { error: "body too large" });
  const raw = await req.text();
  if (Buffer.byteLength(raw) > MAX_BODY_BYTES) return json(413, { error: "body too large" });

  const auth = verifyIngestRequest(req.headers, raw, { apiKey, hmacSecret });
  if (!auth.ok) return json(401, { error: auth.error });

  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return json(400, { error: "body must be JSON" });
  }

  const batch = typeof body === "object" && body !== null && "events" in body;
  const events = batch ? (body as { events: unknown }).events : [body];
  if (!Array.isArray(events) || events.length === 0) return json(400, { error: "events must be a non-empty array" });
  if (events.length > MAX_EVENTS) return json(413, { error: `at most ${MAX_EVENTS} events per request` });

  // Sequential, so repeat events for the same person in one batch apply in order.
  const results = [];
  for (const [index, event] of events.entries()) {
    const r = await ingestConvoEvent(event, { via: "api" });
    results.push(r.ok ? { index, ok: true, ...r.data } : { index, ok: false, error: r.error });
  }
  return json(200, batch ? { results } : results[0]);
}
