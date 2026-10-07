// Parses Telegram Pool bulk paste / CSV into account rows (PLAN.md §5).
// One account per line: username, phone[, link]. Comma, tab or semicolon separated.
import { parsePhoneNumberFromString } from "libphonenumber-js";
import { normalizeHandle } from "@/lib/telegram";

export type PoolRow = { username: string; phone: string; link: string };
export type ParsedLine = { line: number; raw: string; row: PoolRow };
export type PoolReject = { line: number; raw: string; reason: string };

export function normalizePhone(input: string): string | null {
  const phone = parsePhoneNumberFromString(input.trim());
  return phone && phone.isPossible() ? phone.number : null; // E.164
}

/** Account handles are stored lowercase; Telegram treats them case-insensitively. */
export function normalizeAccountUsername(input: string): string | null {
  return normalizeHandle(input)?.toLowerCase() ?? null;
}

export function normalizeAccountLink(input: string | undefined, username: string): string | null {
  const raw = input?.trim();
  if (!raw) return `https://t.me/${username}`;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.hostname !== "t.me" || url.pathname.length < 2) return null;
  return url.toString();
}

export function validatePoolRow(fields: {
  username: string;
  phone: string;
  link?: string;
}): { row: PoolRow } | { error: string } {
  const username = normalizeAccountUsername(fields.username);
  if (!username) return { error: "invalid username" };
  const phone = normalizePhone(fields.phone);
  if (!phone) return { error: "invalid phone (use international format, e.g. +13095550100)" };
  const link = normalizeAccountLink(fields.link, username);
  if (!link) return { error: "invalid link (must be https://t.me/...)" };
  return { row: { username, phone, link } };
}

/** Validates every line and drops duplicates within the paste. DB duplicates are checked by the caller. */
export function parsePoolImport(text: string): { rows: ParsedLine[]; rejects: PoolReject[] } {
  const rows: ParsedLine[] = [];
  const rejects: PoolReject[] = [];
  const seen = new Set<string>();

  text.split(/\r?\n/).forEach((rawLine, i) => {
    const raw = rawLine.trim();
    if (!raw) return;
    const cells = raw.split(/[,\t;]/).map((c) => c.trim().replace(/^"|"$/g, ""));
    if (i === 0 && cells[0]?.toLowerCase() === "username") return; // header row

    const [username = "", phone = "", link] = cells;
    const result = validatePoolRow({ username, phone, link });
    if ("error" in result) {
      rejects.push({ line: i + 1, raw, reason: result.error });
    } else if (seen.has(result.row.username)) {
      rejects.push({ line: i + 1, raw, reason: "duplicate in this import" });
    } else {
      seen.add(result.row.username);
      rows.push({ line: i + 1, raw, row: result.row });
    }
  });

  return { rows, rejects };
}
