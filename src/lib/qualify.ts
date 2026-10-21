// The qualification decision (PLAN.md §4, step 6). Pure: all lookups happen in ingest.ts.
import { parsePhoneNumberFromString } from "libphonenumber-js";
import type { ConvoStatus } from "@prisma/client";

// A pseudo-country meaning "Capitalbot verified this fan as Tier 1" — used as the `country` value
// when the fan's phone is hidden and no click placed them, so a normal AI reply still qualifies.
export const AI_TIER1 = "T1";

export type DecisionInput = {
  accountKnown: boolean; // the Telegram account is in the pool
  attributed: boolean; // a VA held the account when the first message arrived
  country: string | null; // ISO-2 (from phone or matched click), or AI_TIER1 when Capitalbot verified it
  tier1: readonly string[];
  blockedSource: boolean;
  replied: boolean;
  aiNonTier1?: boolean; // Capitalbot tier-filtered the fan and we have no phone/click country
};

export type Decision =
  | { status: "QUALIFIED" }
  | { status: "PENDING" }
  | { status: "REJECTED"; rejectReason: "non_tier1" | "blocked_source" }
  | { status: "REVIEW"; reviewReason: "unknown_account" | "unattributed" | "unknown_country" };

export function decide(i: DecisionInput): Decision {
  if (!i.accountKnown) return { status: "REVIEW", reviewReason: "unknown_account" };
  if (i.country && i.country !== AI_TIER1 && !i.tier1.includes(i.country)) return { status: "REJECTED", rejectReason: "non_tier1" };
  // Capitalbot tier-filtered the fan, and no phone/click country says otherwise: reject right away,
  // reply or not. A known country always wins, so this only fires when `country` is null.
  if (!i.country && i.aiNonTier1) return { status: "REJECTED", rejectReason: "non_tier1" };
  if (i.blockedSource) return { status: "REJECTED", rejectReason: "blocked_source" };
  if (!i.replied) return { status: "PENDING" };
  if (!i.attributed) return { status: "REVIEW", reviewReason: "unattributed" };
  if (!i.country) return { status: "REVIEW", reviewReason: "unknown_country" };
  return { status: "QUALIFIED" };
}

/** Once a convo is QUALIFIED or REJECTED its outcome never changes (it counts exactly once). */
export function isFinal(status: ConvoStatus): boolean {
  return status === "QUALIFIED" || status === "REJECTED";
}

/** "+44 7700 900123" → "GB". Null when the number doesn't resolve to a single country. */
export function countryFromPhone(phone: string | null | undefined): string | null {
  if (!phone) return null;
  const p = parsePhoneNumberFromString(phone.trim().startsWith("+") ? phone.trim() : `+${phone.trim()}`);
  return p?.isPossible() && p.country ? p.country : null;
}
