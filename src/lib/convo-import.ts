// Director → Import convos (CSV). Each row goes through ingestConvoEvent, like an API event.
import type { ConvoStatus } from "@prisma/client";
import { db } from "@/lib/db";
import { fail, type Result } from "@/lib/action-result";
import type { CurrentUser } from "@/lib/auth/session";
import { parseConvoCsv } from "@/lib/csv";
import { ingestConvoEvent } from "@/lib/ingest";

export const MAX_IMPORT_ROWS = 5000;

export type ConvoImportSummary = {
  rows: number;
  byStatus: Partial<Record<ConvoStatus, number>>;
  unchanged: number; // repeat of something already decided
  late: number;
  errors: { line: number; error: string }[];
};

export async function importConvosCsv(actor: CurrentUser, text: string): Promise<Result<ConvoImportSummary>> {
  if (actor.role !== "DIRECTOR") return fail("Only the Director can import convos.");
  const parsed = parseConvoCsv(text);
  if ("error" in parsed) return fail(parsed.error);
  if (parsed.rows.length === 0) return fail("No rows to import.");
  if (parsed.rows.length > MAX_IMPORT_ROWS) return fail(`Import at most ${MAX_IMPORT_ROWS} rows at a time.`);

  const summary: ConvoImportSummary = { rows: parsed.rows.length, byStatus: {}, unchanged: 0, late: 0, errors: [] };
  for (const { line, event } of parsed.rows) {
    const r = await ingestConvoEvent(event, { via: "csv", actorId: actor.id });
    if (!r.ok) {
      summary.errors.push({ line, error: r.error });
      continue;
    }
    if (!r.data.changed) summary.unchanged++;
    else summary.byStatus[r.data.status] = (summary.byStatus[r.data.status] ?? 0) + 1;
    if (r.data.late) summary.late++;
  }

  await db.auditLog.create({
    data: {
      actorId: actor.id,
      action: "convo.import",
      meta: { rows: summary.rows, errors: summary.errors.length, byStatus: summary.byStatus, unchanged: summary.unchanged },
    },
  });
  return { ok: true, data: summary };
}
