// GET /api/ingest/stats — read-only current-week convo breakdown for the Telegram panel's Stats
// screen, so its "Qualified this week" equals the VA dashboard. Auth: the same HMAC as the convo
// ingest (src/lib/ingest-auth.ts), signed over an empty body.
import { db } from "@/lib/db";
import { verifyIngestRequest } from "@/lib/ingest-auth";
import { getSetting } from "@/lib/settings";
import { weekBounds } from "@/lib/weeks";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const json = (status: number, body: unknown) => Response.json(body, { status, headers: { "Cache-Control": "no-store" } });

export async function GET(req: Request) {
  const apiKey = process.env.INGEST_API_KEY;
  const hmacSecret = process.env.INGEST_HMAC_SECRET;
  if (!apiKey || !hmacSecret) return json(503, { error: "ingest not configured" });

  const auth = verifyIngestRequest(req.headers, "", { apiKey, hmacSecret });
  if (!auth.ok) return json(401, { error: auth.error });

  const tz = await getSetting("timezone");
  const week = weekBounds(new Date(), tz);
  const firstMsgInWeek = { gte: week.startsAt, lt: week.endsAt };
  // Qualified is counted by the pay week it landed in (Convo.week.startsAt) — identical to the
  // dashboards' `inWeek` in src/lib/stats.ts. Pending/Rejected/Review aren't week-bound, so they're
  // scoped by when the fan first wrote.
  const [qualified, pending, rejected, review] = await Promise.all([
    db.convo.count({ where: { status: "QUALIFIED", week: { startsAt: week.startsAt } } }),
    db.convo.count({ where: { status: "PENDING", firstMsgAt: firstMsgInWeek } }),
    db.convo.count({ where: { status: "REJECTED", firstMsgAt: firstMsgInWeek } }),
    db.convo.count({ where: { status: "REVIEW", firstMsgAt: firstMsgInWeek } }),
  ]);

  return json(200, {
    timezone: tz,
    week: { startsAt: week.startsAt.toISOString(), endsAt: week.endsAt.toISOString() },
    counts: { qualified, pending, rejected, review },
  });
}
