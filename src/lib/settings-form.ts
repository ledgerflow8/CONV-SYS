// Validates the Director's Settings form into typed Settings. Pure; safe to import on the client.
import { normalizeDomain } from "@/lib/clicks";
import { parseDollarsToCents } from "@/lib/money";
import type { Settings } from "@/lib/settings-defaults";
import { normalizeHandle } from "@/lib/telegram";

// Fixed-offset zones only, so a pay week is always exactly 7×24h (no DST jumps).
// Note the IANA sign flip: Etc/GMT-2 is UTC+2.
export const TIMEZONES: string[] = [
  ...Array.from({ length: 12 }, (_, i) => `Etc/GMT+${12 - i}`),
  "UTC",
  ...Array.from({ length: 14 }, (_, i) => `Etc/GMT-${i + 1}`),
];

export type SettingsFormInput = {
  rateVa: string;
  rateLeadVa: string;
  rateLm: string;
  tier1Countries: string;
  blockedDomains: string;
  timezone: string;
  payoutCurrency: string;
  clickMatchWindowMin: string;
  supportTelegram: string;
  prizeVa1: string;
  prizeVa2: string;
  prizeVa3: string;
  prizeLeadVa1: string;
  prizeLeadVa2: string;
  prizeLeadVa3: string;
  minVa1: string;
  minVa2: string;
  minVa3: string;
  minLeadVa1: string;
  minLeadVa2: string;
  minLeadVa3: string;
  prizePassDown: "no" | "yes";
};

export const PRIZE_FIELDS = {
  va: ["prizeVa1", "prizeVa2", "prizeVa3"],
  leadVa: ["prizeLeadVa1", "prizeLeadVa2", "prizeLeadVa3"],
} as const;

export const MIN_FIELDS = {
  va: ["minVa1", "minVa2", "minVa3"],
  leadVa: ["minLeadVa1", "minLeadVa2", "minLeadVa3"],
} as const;

export type SettingsFormErrors = Partial<Record<keyof SettingsFormInput, string>>;

const MAX_RATE_CENTS = 10_000; // $100 per convo: guards against a typo like "25" meaning cents
const MAX_PRIZE_CENTS = 100_000; // $1,000 per prize
const MAX_MIN_CONVOS = 1_000_000;

export function parseSettingsForm(
  input: SettingsFormInput,
): { ok: true; settings: Settings } | { ok: false; errors: SettingsFormErrors } {
  const errors: SettingsFormErrors = {};

  const rate = (field: "rateVa" | "rateLeadVa" | "rateLm") => {
    const cents = parseDollarsToCents(input[field]);
    if (cents === null) errors[field] = "Enter an amount like 0.25";
    else if (cents > MAX_RATE_CENTS) errors[field] = "That's over $100 per convo. Check the amount.";
    return cents ?? 0;
  };
  const rates = { va: rate("rateVa"), leadVa: rate("rateLeadVa"), lm: rate("rateLm") };

  const countries = [...new Set(input.tier1Countries.toUpperCase().split(/[\s,]+/).filter(Boolean))];
  const badCountries = countries.filter((c) => !/^[A-Z]{2}$/.test(c));
  if (badCountries.length) errors.tier1Countries = `Not 2-letter country codes: ${badCountries.join(", ")}`;
  else if (countries.length === 0) errors.tier1Countries = "Add at least one country.";

  const domainLines = input.blockedDomains.split(/[\n,]+/).map((d) => d.trim()).filter(Boolean);
  const domains: string[] = [];
  const badDomains: string[] = [];
  for (const line of domainLines) {
    const d = normalizeDomain(line);
    if (d) {
      if (!domains.includes(d)) domains.push(d);
    } else badDomains.push(line);
  }
  if (badDomains.length) errors.blockedDomains = `Not valid domains: ${badDomains.slice(0, 5).join(", ")}`;

  if (!TIMEZONES.includes(input.timezone)) errors.timezone = "Pick a timezone from the list.";

  const currency = input.payoutCurrency.trim();
  if (currency.length < 2 || currency.length > 30) errors.payoutCurrency = "2–30 characters, e.g. USDT";

  const windowMin = Number(input.clickMatchWindowMin);
  if (!Number.isInteger(windowMin) || windowMin < 1 || windowMin > 1440) {
    errors.clickMatchWindowMin = "Whole minutes between 1 and 1440.";
  }

  const supportRaw = input.supportTelegram.trim();
  const support = supportRaw ? normalizeHandle(supportRaw) : "";
  if (support === null) errors.supportTelegram = "Not a valid Telegram username.";

  const prize = (field: (typeof PRIZE_FIELDS)[keyof typeof PRIZE_FIELDS][number]) => {
    const cents = parseDollarsToCents(input[field]);
    if (cents === null) errors[field] = "Enter an amount like 10 (0 = no prize)";
    else if (cents > MAX_PRIZE_CENTS) errors[field] = "That's over $1,000. Check the amount.";
    return cents ?? 0;
  };
  const leaderboardPrizes = { va: PRIZE_FIELDS.va.map(prize), leadVa: PRIZE_FIELDS.leadVa.map(prize) };

  const minimum = (field: (typeof MIN_FIELDS)[keyof typeof MIN_FIELDS][number]) => {
    const raw = input[field].trim();
    const n = raw === "" ? 0 : Number(raw);
    if (!/^\d*$/.test(raw) || !Number.isInteger(n) || n > MAX_MIN_CONVOS) errors[field] = "Whole number of convos (0 = no minimum)";
    return Number.isInteger(n) ? n : 0;
  };
  const leaderboardMinConvos = { va: MIN_FIELDS.va.map(minimum), leadVa: MIN_FIELDS.leadVa.map(minimum) };
  if (input.prizePassDown !== "yes" && input.prizePassDown !== "no") errors.prizePassDown = "Pick one.";

  if (Object.keys(errors).length) return { ok: false, errors };
  return {
    ok: true,
    settings: {
      rates,
      tier1Countries: countries,
      blockedDomains: domains,
      timezone: input.timezone,
      payoutCurrency: currency,
      clickMatchWindowMin: windowMin,
      supportTelegram: support ?? "",
      leaderboardPrizes,
      leaderboardMinConvos,
      leaderboardPassDown: input.prizePassDown === "yes",
    },
  };
}
