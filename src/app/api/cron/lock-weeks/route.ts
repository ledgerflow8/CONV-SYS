// Vercel Cron (vercel.json): locks every finished pay week and generates its payouts.
import { cronAuthError } from "@/lib/cron-auth";
import { lockFinishedWeeks } from "@/lib/payouts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const denied = cronAuthError(req);
  if (denied) return denied;
  const results = await lockFinishedWeeks(null);
  return Response.json({ locked: results.filter((r) => !r.alreadyLocked), checked: results.length });
}
