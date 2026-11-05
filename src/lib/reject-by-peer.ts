// Director-only correction tool (client 2026-11-05): paste/upload a list of (tgAccount, peerId) and
// set those convos to REJECTED, but only in unlocked weeks (a locked week never changes — CLAUDE.md).
// Built for convos the panel audit flags as "qualified with no real reply". Preview first, then apply.
import { db } from "@/lib/db";
import { audit } from "@/lib/audit";
import { fail, type Result } from "@/lib/action-result";
import type { CurrentUser } from "@/lib/auth/session";

export const PEER_REJECT_REASON = "audit_no_reply";
export const MAX_PEER_REJECT = 5000;

export type PeerRef = { tgAccount: string; peerId: string };
export type PeerRowStatus = "found" | "already_rejected" | "locked_week" | "not_found" | "invalid";
export type PeerRow = PeerRef & { status: PeerRowStatus; convoId?: string };
export type PeerPreview = { rows: PeerRow[]; counts: Record<PeerRowStatus, number> };

/** Parse pasted/uploaded text: one "tgAccount, peerId" per line (comma, tab or spaces). */
export function parsePeerList(text: string): PeerRow[] {
  const rows: PeerRow[] = [];
  const seen = new Set<string>();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || /^(tgaccount|account)\b/i.test(line)) continue; // skip blanks and a header row
    const parts = line.split(/[,\t]|\s+/).filter(Boolean);
    const tgAccount = (parts[0] ?? "").replace(/^@/, "").toLowerCase();
    const peerId = (parts[1] ?? "").trim();
    if (!tgAccount || !peerId) {
      rows.push({ tgAccount: parts[0] ?? line, peerId: peerId, status: "invalid" });
      continue;
    }
    const key = `${tgAccount}\u0000${peerId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push({ tgAccount, peerId, status: "not_found" });
  }
  return rows;
}

function emptyCounts(): Record<PeerRowStatus, number> {
  return { found: 0, already_rejected: 0, locked_week: 0, not_found: 0, invalid: 0 };
}

async function classify(rows: PeerRow[]): Promise<PeerPreview> {
  const counts = emptyCounts();
  for (const row of rows) {
    if (row.status === "invalid") {
      counts.invalid++;
      continue;
    }
    const convo = await db.convo.findUnique({
      where: { accountRef_peerId: { accountRef: row.tgAccount, peerId: row.peerId } },
      select: { id: true, status: true, week: { select: { status: true } } },
    });
    if (!convo) row.status = "not_found";
    else if (convo.status === "REJECTED") row.status = "already_rejected";
    else if (convo.week?.status === "LOCKED") row.status = "locked_week";
    else {
      row.status = "found";
      row.convoId = convo.id;
    }
    counts[row.status]++;
  }
  return { rows, counts };
}

/** Preview: categorise every line as found / already rejected / in a locked week / not found / invalid. */
export async function previewPeerReject(actor: CurrentUser, text: string): Promise<Result<PeerPreview>> {
  if (actor.role !== "DIRECTOR") return fail("Only the Director can reject convos by peer list.");
  const rows = parsePeerList(text);
  if (rows.length === 0) return fail("Paste at least one line of 'tgAccount, peerId'.");
  if (rows.length > MAX_PEER_REJECT) return fail(`Too many lines (${rows.length}). Do at most ${MAX_PEER_REJECT} at a time.`);
  return { ok: true, data: await classify(rows) };
}

export type PeerRejectOutcome = { rejected: number; skipped: { tgAccount: string; peerId: string; reason: PeerRowStatus }[] };

/** Apply: reject the convos that are still found & in an unlocked week. Re-checked under a row lock. */
export async function applyPeerReject(actor: CurrentUser, text: string): Promise<Result<PeerRejectOutcome>> {
  if (actor.role !== "DIRECTOR") return fail("Only the Director can reject convos by peer list.");
  const preview = await classify(parsePeerList(text));
  const targets = preview.rows.filter((r) => r.status === "found");
  const out: PeerRejectOutcome = { rejected: 0, skipped: [] };

  for (const row of targets) {
    const done = await db.$transaction(async (tx) => {
      const [locked] = await tx.$queryRaw<{ id: string; status: string; weekId: string | null }[]>`
        SELECT id, status, "weekId" FROM "Convo" WHERE "accountRef" = ${row.tgAccount} AND "peerId" = ${row.peerId} FOR UPDATE`;
      if (!locked) return "not_found" as const;
      if (locked.status === "REJECTED") return "already_rejected" as const;
      if (locked.weekId) {
        const week = await tx.week.findUnique({ where: { id: locked.weekId }, select: { status: true } });
        if (week?.status === "LOCKED") return "locked_week" as const;
      }
      // Detach from its week and zero the snapshotted earnings so a corrected convo can't be paid.
      await tx.convo.update({
        where: { id: locked.id },
        data: { status: "REJECTED", rejectReason: PEER_REJECT_REASON, reviewReason: null, weekId: null, qualifiedAt: null, vaCents: 0, leadVaCents: 0, lmCents: 0 },
      });
      await audit(tx, { actorId: actor.id, action: "convo.status", target: locked.id, meta: { from: locked.status, to: "REJECTED", reason: PEER_REJECT_REASON, via: "peer_list" } });
      return "ok" as const;
    });
    if (done === "ok") out.rejected++;
    else out.skipped.push({ tgAccount: row.tgAccount, peerId: row.peerId, reason: done });
  }
  return { ok: true, data: out };
}
