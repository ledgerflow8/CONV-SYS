import { TopBar } from "@/components/shell/top-bar";
import { requireRole } from "@/lib/auth/session";
import { centsToDollars } from "@/lib/money";
import { getAllSettings } from "@/lib/settings";
import { TIMEZONES } from "@/lib/settings-form";
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
        }}
      />
    </>
  );
}
