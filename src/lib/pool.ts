// Telegram account pool: add one / bulk import (PLAN.md §5). Ban/reassign is Block 10.
import { db } from "@/lib/db";
import { audit } from "@/lib/audit";
import { fail, isUniqueViolation, type Result } from "@/lib/action-result";
import type { CurrentUser } from "@/lib/auth/session";
import { parsePoolImport, validatePoolRow, type PoolReject } from "@/lib/pool-import";

async function requireActiveModel(modelId: string) {
  return db.model.findFirst({ where: { id: modelId, active: true }, select: { id: true } });
}

export async function addPoolAccount(
  actor: CurrentUser,
  input: { modelId: string; username: string; phone: string; link?: string },
): Promise<Result<{ id: string }>> {
  if (actor.role !== "DIRECTOR") return fail("Only the Director can add accounts.");
  if (!(await requireActiveModel(input.modelId))) return fail("Pick an active model.");

  const v = validatePoolRow(input);
  if ("error" in v) return fail(`Can't add: ${v.error}.`);

  try {
    const id = await db.$transaction(async (tx) => {
      const account = await tx.tgAccount.create({ data: { modelId: input.modelId, ...v.row } });
      await audit(tx, { actorId: actor.id, action: "tg.add", target: account.id, meta: { username: v.row.username } });
      return account.id;
    });
    return { ok: true, data: { id } };
  } catch (e) {
    if (isUniqueViolation(e)) return fail(`@${v.row.username} is already in the pool.`);
    throw e;
  }
}

export type ImportSummary = { added: number; rejects: PoolReject[] };

/** Adds every valid, new row; reports the rest by line. Duplicates are rejected by username. */
export async function importPoolAccounts(
  actor: CurrentUser,
  input: { modelId: string; text: string },
): Promise<Result<ImportSummary>> {
  if (actor.role !== "DIRECTOR") return fail("Only the Director can import accounts.");
  if (!(await requireActiveModel(input.modelId))) return fail("Pick an active model.");

  const { rows, rejects } = parsePoolImport(input.text);
  if (rows.length === 0 && rejects.length === 0) return fail("Paste at least one account.");
  if (rows.length > 2000) return fail("Import at most 2000 accounts at a time.");

  const added = await db.$transaction(async (tx) => {
    const existing = await tx.tgAccount.findMany({
      where: { username: { in: rows.map((r) => r.row.username) } },
      select: { username: true },
    });
    const taken = new Set(existing.map((e) => e.username));
    const fresh = rows.filter((r) => !taken.has(r.row.username));
    for (const r of rows) {
      if (taken.has(r.row.username)) rejects.push({ line: r.line, raw: r.raw, reason: "already in the pool" });
    }
    rejects.sort((a, b) => a.line - b.line);

    // skipDuplicates covers a concurrent import adding the same username between check and insert.
    const { count } = await tx.tgAccount.createMany({
      data: fresh.map((r) => ({ modelId: input.modelId, ...r.row })),
      skipDuplicates: true,
    });
    await audit(tx, {
      actorId: actor.id,
      action: "tg.import",
      target: input.modelId,
      meta: { added: count, rejected: rejects.length },
    });
    return count;
  });

  return { ok: true, data: { added, rejects } };
}
