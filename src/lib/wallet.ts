// Payout wallets (PLAN.md §7): EVM-style 0x + 40 hex. Validation only — no keys, no sending.

export function normalizeWallet(input: string): string | null {
  const w = input.trim();
  return /^0x[0-9a-fA-F]{40}$/.test(w) ? w : null;
}

/** Transaction hash pasted when marking a payout paid: 64 hex, with or without 0x (EVM or TRON). */
export function normalizeTxHash(input: string): string | null {
  const h = input.trim();
  return /^(0x)?[0-9a-fA-F]{64}$/.test(h) ? h : null;
}

/** "0x12ab…cd34" for compact display. */
export function shortWallet(w: string): string {
  return `${w.slice(0, 6)}…${w.slice(-4)}`;
}
