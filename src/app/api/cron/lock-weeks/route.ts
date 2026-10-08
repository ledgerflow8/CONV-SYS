// Vercel Cron (vercel.json): locks every finished pay week and generates its payouts.
// Vercel sends "Authorization: Bearer <CRON_SECRET>".
import { timingSafeEqual } from "node:crypto";
import { lockFinishedWeeks } from "@/lib/payouts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function authorized(header: string | null, secret: string) {
  const a = Buffer.from(header ?? "");
  const b = Buffer.from(`Bearer ${secret}`);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return Response.json({ error: "cron not configured" }, { status: 503 });
  if (!authorized(req.headers.get("authorization"), secret)) return Response.json({ error: "unauthorized" }, { status: 401 });

  const results = await lockFinishedWeeks(null);
  return Response.json({ locked: results.filter((r) => !r.alreadyLocked), checked: results.length });
}
