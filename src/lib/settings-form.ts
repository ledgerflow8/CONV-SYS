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
};

export type SettingsFormErrors = Partial<Record<keyof SettingsFormInput, string>>;

const MAX_RATE_CENTS = 10_000; // $100 per convo: guards against a typo like "25" meaning cents

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
  if (currency.length < 2 || currency.length > 30) errors.payoutCurrency = "2–30 characters, e.g. USDT (TRC-20)";

  const windowMin = Number(input.clickMatchWindowMin);
  if (!Number.isInteger(windowMin) || windowMin < 1 || windowMin > 1440) {
    errors.clickMatchWindowMin = "Whole minutes between 1 and 1440.";
  }

  const supportRaw = input.supportTelegram.trim();
  const support = supportRaw ? normalizeHandle(supportRaw) : "";
  if (support === null) errors.supportTelegram = "Not a valid Telegram username.";

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
    },
  };
}
