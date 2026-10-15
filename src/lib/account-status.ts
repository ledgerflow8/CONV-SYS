// Account-status ingest (PLAN.md §10.1). Record-only: the panel tells us the last-known Telegram
// state of an account; we store it and surface it in the Director's pool, but NEVER change
// TgStatus or VA assignments and never notify. A real ban stays a human action in the pool UI.
import { z } from "zod";
import { db } from "@/lib/db";

const ISO_WITH_ZONE = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,6})?)?(?:Z|[+-]\d{2}:?\d{2})$/i;

export const accountStatusSchema = z.object({
  tgAccount: z.string().trim().min(1).max(64),
  status: z.enum(["online", "offline", "limited", "banned", "revoked"]),
  at: z
    .string()
    .trim()
    .regex(ISO_WITH_ZONE, "must be ISO 8601 with a timezone")
    .transform((s, ctx) => {
      const d = new Date(s.replace(" ", "T"));
      if (Number.isNaN(d.getTime())) {
        ctx.addIssue({ code: "custom", message: "is not a real date" });
        return z.NEVER;
      }
      return d;
    }),
  detail: z.preprocess((v) => (v === "" || v === null ? undefined : v), z.string().trim().max(500).optional()),
});

export type AccountStatusEvent = z.input<typeof accountStatusSchema>;

export type AccountStatusOutcome = { recorded: boolean; reason?: "unknown_account" | "stale" };

export function formatEventError(error: z.ZodError): string {
  return error.issues.map((i) => `${i.path.join(".") || "event"} ${i.message}`).join("; ");
}

/**
 * Record the panel's status for one account. Matches by username (or id), like convo ingest.
 * An unknown account is acknowledged, not rejected, so the panel never piles up failed rows for
 * accounts that aren't in the pool yet. Older reports than what we already have are ignored.
 */
export async function recordAccountStatus(raw: unknown): Promise<{ ok: true; data: AccountStatusOutcome } | { ok: false; error: string }> {
  const parsed = accountStatusSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, error: formatEventError(parsed.error) };
  const e = parsed.data;

  const input = e.tgAccount.replace(/^@/, "");
  const account = await db.tgAccount.findFirst({
    where: { OR: [{ username: input.toLowerCase() }, { id: input }] },
    select: { id: true, lastSeenAt: true },
  });
  if (!account) return { ok: true, data: { recorded: false, reason: "unknown_account" } };
  if (account.lastSeenAt && account.lastSeenAt > e.at) return { ok: true, data: { recorded: false, reason: "stale" } };

  await db.tgAccount.update({ where: { id: account.id }, data: { panelStatus: e.status, lastSeenAt: e.at } });
  return { ok: true, data: { recorded: true } };
}
