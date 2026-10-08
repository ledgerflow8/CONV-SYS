import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { LiveRefresh } from "@/components/live-refresh";
import { StatCard } from "@/components/stat-card";
import { StatusBadge } from "@/components/status-badge";
import { TopBar } from "@/components/shell/top-bar";
import { WalletDialog } from "@/components/wallet-dialog";
import type { CurrentUser } from "@/lib/auth/session";
import { formatCents } from "@/lib/money";
import { getSetting } from "@/lib/settings";
import { commissionSummary, currentPeriods } from "@/lib/stats";
import { formatDay, formatPeriod } from "@/lib/time";

const HOW: Record<"LEAD_VA" | "LEAD_MANAGER", { rateKey: "leadVa" | "lm"; basis: string }> = {
  LEAD_VA: { rateKey: "leadVa", basis: "for every qualified convo from anyone on your team" },
  LEAD_MANAGER: { rateKey: "lm", basis: "for every qualified convo across all your teams" },
};

export async function CommissionPage({ user }: { user: CurrentUser & { role: "LEAD_VA" | "LEAD_MANAGER" } }) {
  const { week, timeZone } = await currentPeriods();
  const [s, rates, currency] = await Promise.all([commissionSummary(user, week), getSetting("rates"), getSetting("payoutCurrency")]);
  const how = HOW[user.role];
  const rate = rates[how.rateKey];

  return (
    <>
      <TopBar title="Payouts" emoji="💸" />
      <LiveRefresh />

      <div className="mb-4 grid grid-cols-2 gap-3">
        <StatCard label="Current commission (not paid yet)" value={formatCents(s.currentCents)} tone="good" hint={`${s.currentConvos} convos · ${formatPeriod(week, timeZone)}`} />
        <StatCard label="Paid to date" value={formatCents(s.paidToDateCents)} />
        <StatCard label="Total convos" value={s.totalConvos} />
        <StatCard
          label="Weekly average (past weeks)"
          value={formatCents(s.weeklyAverageCents)}
          hint={s.bestWeek ? `Best: ${formatCents(s.bestWeek.cents)} (${formatPeriod(s.bestWeek, timeZone)})` : "No earnings yet"}
        />
      </div>

      <Card className="mb-4">
        <CardHeader>
          <CardTitle className="text-base">Payout wallet</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-wrap items-center justify-between gap-3">
          {user.walletAddress ? (
            <code className="text-xs break-all">{user.walletAddress}</code>
          ) : (
            <span className="text-sm text-destructive">No wallet yet. Add one so you can get paid.</span>
          )}
          <WalletDialog current={user.walletAddress} currency={currency} />
        </CardContent>
      </Card>

      <Card className="mb-4">
        <CardHeader>
          <CardTitle className="text-base">Commission history</CardTitle>
        </CardHeader>
        <CardContent className="px-0">
          <ul className="divide-y">
            {s.history.length === 0 && <li className="px-6 py-2 text-sm text-muted-foreground">No payouts yet. Your first one comes after this week locks.</li>}
            {s.history.map((h) => (
              <li key={h.id} className="flex items-center justify-between gap-2 px-6 py-2 text-sm">
                <span>{formatPeriod(h, timeZone)}</span>
                <span className="text-muted-foreground">{h.convos} convos</span>
                <span className="flex items-center gap-2 font-medium">
                  {formatCents(h.amountCents)} <StatusBadge status={h.status} />
                </span>
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">How you earn</CardTitle>
        </CardHeader>
        <CardContent className="space-y-1 text-sm">
          <p>
            <strong>{formatCents(rate)}</strong> {how.basis}.
          </p>
          <p className="text-muted-foreground">
            Weeks run Monday to Sunday ({timeZone === "UTC" ? "UTC" : "org time"}). Each week locks on {formatDay(week.endsAt, timeZone)} at
            00:00 and is paid in {currency} to your wallet.
          </p>
        </CardContent>
      </Card>
    </>
  );
}
