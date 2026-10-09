// cron-job.org, every 5 minutes: pull new CapitalAI conversations into the convo pipeline.
// Header: Authorization: Bearer <CRON_SECRET>. Returns the run summary (or why it didn't run).
import { cronAuthError } from "@/lib/cron-auth";
import { syncCapitalAI } from "@/lib/capitalai-sync";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60; // seconds; the sync stops itself at ~45s and continues next run

async function handle(req: Request) {
  const denied = cronAuthError(req);
  if (denied) return denied;
  const r = await syncCapitalAI({ budgetMs: 45_000 });
  // 200 even when busy or the licence fails: the run itself worked, and cron-job.org would
  // otherwise disable the job after repeated failures. The reason is in the body and on the Convos page.
  return Response.json(r, { headers: { "Cache-Control": "no-store" } });
}

export const GET = handle;
export const POST = handle;
