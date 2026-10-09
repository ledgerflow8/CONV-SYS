// Scheduler endpoints (Vercel Cron, cron-job.org) authenticate with "Authorization: Bearer <CRON_SECRET>".
import { timingSafeEqual } from "node:crypto";

export function cronAuthError(req: Request): Response | null {
  const secret = process.env.CRON_SECRET;
  if (!secret) return Response.json({ error: "cron not configured" }, { status: 503 });
  const a = Buffer.from(req.headers.get("authorization") ?? "");
  const b = Buffer.from(`Bearer ${secret}`);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return Response.json({ error: "unauthorized" }, { status: 401 });
  return null;
}
