// Money is integer cents everywhere (CLAUDE.md). These convert at the UI edge without floats.

/** "0.25" → 25, "1" → 100, "$1.5" → 150. Null if not a non-negative amount with ≤ 2 decimals. */
export function parseDollarsToCents(input: string): number | null {
  const m = input.trim().replace(/^\$/, "").match(/^(\d{1,6})(?:\.(\d{1,2}))?$/);
  if (!m) return null;
  return Number(m[1]) * 100 + Number((m[2] ?? "").padEnd(2, "0"));
}

/** 25 → "0.25", 150 → "1.50". */
export function centsToDollars(cents: number): string {
  if (!Number.isInteger(cents)) throw new Error("cents must be an integer");
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
}

export function formatCents(cents: number): string {
  return `$${centsToDollars(cents)}`;
}
