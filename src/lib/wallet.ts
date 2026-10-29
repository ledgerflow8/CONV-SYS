// Payout wallets (PLAN.md §7): Aptos accounts since 2026-10-29 (were EVM 0x + 40 hex). An Aptos address
// is 32 bytes: 0x + 64 hex. Short forms (leading zeros dropped) are accepted and stored left-padded,
// lowercase. Validation only — no keys, no sending. Pure: safe to import on the client.

export const WALLET_NETWORK = "Aptos";

const HEX = /^0x[0-9a-fA-F]{1,64}$/;
const EVM = /^0x[0-9a-fA-F]{40}$/;
const STORED = /^0x[0-9a-f]{64}$/;

export type WalletCheck = { ok: true; address: string } | { ok: false; error: string };

export function checkWallet(input: string): WalletCheck {
  const w = input.trim();
  // An old EVM address would otherwise pass as a "short form" and be padded into an Aptos account no one owns.
  if (EVM.test(w)) {
    return { ok: false, error: "That's an Ethereum-style address (40 characters). Payouts are on Aptos now: paste your Aptos address (0x + 64 characters)." };
  }
  if (!HEX.test(w)) return { ok: false, error: "Enter an Aptos address: 0x followed by 64 hex characters (0–9, a–f)." };
  const address = `0x${w.slice(2).toLowerCase().padStart(64, "0")}`;
  // 0x0–0xf are Aptos's reserved system accounts (0x1 is the framework), never a person's wallet.
  if (/^0x0{63}[0-9a-f]$/.test(address)) return { ok: false, error: "That's a reserved Aptos system address, not a wallet." };
  return { ok: true, address };
}

/** The stored (padded, lowercase) Aptos address, or null if the input isn't one. */
export function normalizeWallet(input: string): string | null {
  const r = checkWallet(input);
  return r.ok ? r.address : null;
}

/** True for a stored Aptos address. False for null and for addresses saved before the move to Aptos. */
export function isAptosAddress(w: string | null | undefined): w is string {
  return !!w && STORED.test(w);
}

/** Transaction hash pasted when marking a payout paid: 64 hex, with or without 0x (Aptos uses 0x + 64). */
export function normalizeTxHash(input: string): string | null {
  const h = input.trim();
  return /^(0x)?[0-9a-fA-F]{64}$/.test(h) ? h : null;
}

/** "0x12ab…cd34" for compact display. */
export function shortWallet(w: string): string {
  return `${w.slice(0, 6)}…${w.slice(-4)}`;
}
