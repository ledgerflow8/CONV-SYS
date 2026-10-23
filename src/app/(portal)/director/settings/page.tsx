import { TopBar } from "@/components/shell/top-bar";
import { requireRole } from "@/lib/auth/session";
import { centsToDollars } from "@/lib/money";
import { getAllSettings } from "@/lib/settings";
import { PRIZE_FIELDS, TIMEZONES } from "@/lib/settings-form";
import type { Settings } from "@/lib/settings-defaults";
import { tzLabel } from "@/lib/time";
import { SettingsForm } from "./settings-form";

export default async function SettingsPage() {
  await requireRole("DIRECTOR");
  const s = await getAllSettings();

  return (
    <>
      <TopBar title="Settings" emoji="⚙️" />
      <SettingsForm
        timezones={TIMEZONES.map((tz) => ({ value: tz, label: tzLabel(tz) }))}
        initial={{
          rateVa: centsToDollars(s.rates.va),
          rateLeadVa: centsToDollars(s.rates.leadVa),
          rateLm: centsToDollars(s.rates.lm),
          tier1Countries: s.tier1Countries.join(", "),
          blockedDomains: s.blockedDomains.join("\n"),
          timezone: s.timezone,
          payoutCurrency: s.payoutCurrency,
          clickMatchWindowMin: String(s.clickMatchWindowMin),
          supportTelegram: s.supportTelegram ? `@${s.supportTelegram}` : "",
          ...prizeInputs(s.leaderboardPrizes),
        }}
      />
    </>
  );
}

function prizeInputs(p: Settings["leaderboardPrizes"]) {
  const out = {} as Record<(typeof PRIZE_FIELDS)[keyof typeof PRIZE_FIELDS][number], string>;
  for (const board of ["va", "leadVa"] as const) PRIZE_FIELDS[board].forEach((f, i) => (out[f] = centsToDollars(p[board][i] ?? 0)));
  return out;
}
