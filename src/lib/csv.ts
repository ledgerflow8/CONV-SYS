// Minimal RFC 4180 CSV parser: quoted fields, "" escapes, commas/newlines inside quotes, CRLF, BOM.

export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  const s = text.replace(/^﻿/, "");

  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (quoted) {
      if (ch === '"' && s[i + 1] === '"') {
        field += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"' && field === "") quoted = true;
    else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && s[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else field += ch;
  }
  if (field !== "" || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => c.trim() !== ""));
}

// Convo import columns (PLAN.md §4 ConvoEvent). Accepts snake_case or camelCase headers.
const COLUMNS = {
  tgAccount: ["tg_account", "tgaccount", "account"],
  peerId: ["peer_id", "peerid"],
  peerPhone: ["peer_phone", "peerphone", "phone"],
  firstMsgAt: ["first_msg_at", "firstmsgat"],
  repliedAt: ["replied_at", "repliedat"],
  source: ["source"],
} as const;

export type ConvoCsvRow = { line: number; event: Record<keyof typeof COLUMNS, string | undefined> };

export function parseConvoCsv(text: string): { rows: ConvoCsvRow[] } | { error: string } {
  const [header, ...body] = parseCsv(text);
  if (!header) return { error: "The file is empty." };

  const norm = header.map((h) => h.trim().toLowerCase());
  const index = {} as Record<keyof typeof COLUMNS, number>;
  for (const [key, names] of Object.entries(COLUMNS) as [keyof typeof COLUMNS, readonly string[]][]) {
    index[key] = norm.findIndex((h) => names.includes(h));
  }
  const missing = (["tgAccount", "peerId", "firstMsgAt"] as const).filter((k) => index[k] < 0);
  if (missing.length) {
    return { error: `Missing required column(s): ${missing.map((k) => COLUMNS[k][0]).join(", ")}. Header must include tg_account, peer_id, first_msg_at.` };
  }

  return {
    rows: body.map((cells, i) => ({
      line: i + 2,
      event: Object.fromEntries(
        (Object.keys(COLUMNS) as (keyof typeof COLUMNS)[]).map((k) => [k, index[k] >= 0 ? cells[index[k]]?.trim() || undefined : undefined]),
      ) as ConvoCsvRow["event"],
    })),
  };
}
