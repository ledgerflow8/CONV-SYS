import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { CopyButton } from "@/components/copy-button";
import { LiveRefresh } from "@/components/live-refresh";
import { StatCard, WalletBanner } from "@/components/stat-card";
import { TopBar } from "@/components/shell/top-bar";
import { WalletDialog } from "@/components/wallet-dialog";
import { requireRole } from "@/lib/auth/session";
import { db } from "@/lib/db";
import { trackingUrl } from "@/lib/links";
import { formatCents } from "@/lib/money";
import { scopeFor } from "@/lib/scope";
import { getSetting } from "@/lib/settings";
import { currentPeriods, inWeek, qualifiedTotals, qualifiedTotalsBy } from "@/lib/stats";
import { formatDay, formatPeriod } from "@/lib/time";

export default async function VaDashboard() {
  const user = await requireRole("VA");
  const scope = scopeFor(user);
  const { week, timeZone } = await currentPeriods();

  const [thisWeek, byAccount, accounts, me, rates, payouts, currency] = await Promise.all([
    qualifiedTotals(user, inWeek(week)),
    qualifiedTotalsBy(user, "tgAccountId", inWeek(week)),
    db.tgAccount.findMany({
      where: { AND: [scope.tgAccount, { status: "ASSIGNED" }] },
      select: { id: true, username: true, link: true, phone: true },
    }),
    db.user.findUniqueOrThrow({
      where: { id: user.id },
      select: { parent: { select: { username: true } }, trackingLink: { select: { slug: true, active: true } } },
    }),
    getSetting("rates"),
    db.payout.findMany({
      where: scope.payout,
      orderBy: { week: { startsAt: "desc" } },
      take: 12,
      select: { id: true, convos: true, amountCents: true, status: true, week: { select: { startsAt: true, endsAt: true } } },
    }),
    getSetting("payoutCurrency"),
  ]);

  return (
    <>
      <TopBar title="My Accounts" emoji="📱" />
      <LiveRefresh />
      {!user.walletAddress && <WalletBanner currency={currency} />}

      <div className="mb-4 grid grid-cols-2 gap-3">
        <StatCard label="This week's earnings" value={formatCents(thisWeek.vaCents)} tone="good" hint={`${thisWeek.convos} × ${formatCents(rates.va)}`} />
        <StatCard label="Qualified this week" value={thisWeek.convos} />
        <StatCard label="Active Telegrams" value={accounts.length} />
        <StatCard label="Pays out" value={formatDay(week.endsAt, timeZone)} hint="Monday after the week closes" />
      </div>

      <Card className="mb-4">
        <CardHeader>
          <CardTitle className="text-base">My Telegram accounts</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {accounts.length === 0 && <p className="text-sm text-muted-foreground">No account assigned right now. Your Lead VA will sort this out.</p>}
          {accounts.map((a) => (
            <div key={a.id} className="space-y-2 rounded-lg border p-3">
              <div className="flex items-center justify-between gap-2">
                <a href={a.link} target="_blank" rel="noopener noreferrer" className="font-semibold hover:underline">
                  @{a.username}
                </a>
                <span className="text-sm text-muted-foreground">{byAccount.get(a.id)?.convos ?? 0} qualified this week</span>
              </div>
              <div className="flex items-center justify-between gap-2 text-sm">
                <span className="text-muted-foreground">{a.phone}</span>
                <CopyButton value={a.phone} label="Copy" />
              </div>
            </div>
          ))}
          {me.trackingLink?.active && (
            <div className="flex items-center justify-between gap-2 rounded-lg bg-muted/50 p-3 text-sm">
              <div className="min-w-0">
                <div className="text-xs text-muted-foreground">Your tracking link</div>
                <code className="break-all">{trackingUrl(me.trackingLink.slug)}</code>
              </div>
              <CopyButton value={trackingUrl(me.trackingLink.slug)} />
            </div>
          )}
        </CardContent>
      </Card>

      <Card className="mb-4">
        <CardHeader>
          <CardTitle className="text-base">How you get paid</CardTitle>
        </CardHeader>
        <CardContent>
          <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
            <dt className="text-muted-foreground">Rate</dt>
            <dd>{formatCents(rates.va)} per qualified convo</dd>
            <dt className="text-muted-foreground">This week</dt>
            <dd>{formatPeriod(week, timeZone)}</dd>
            <dt className="text-muted-foreground">Pay day</dt>
            <dd>{formatDay(week.endsAt, timeZone)}</dd>
            <dt className="text-muted-foreground">Lead VA</dt>
            <dd>{me.parent ? `@${me.parent.username}` : "—"}</dd>
            <dt className="text-muted-foreground">Wallet</dt>
            <dd className="break-all font-mono text-xs">{user.walletAddress ?? <span className="font-sans text-sm text-destructive">Not set</span>}</dd>
            <dt className="text-muted-foreground">Currency</dt>
            <dd>{currency}</dd>
          </dl>
          <div className="mt-3">
            <WalletDialog current={user.walletAddress} currency={currency} />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Payout history</CardTitle>
        </CardHeader>
        <CardContent className="px-0">
          <ul className="divide-y">
            {payouts.length === 0 && <li className="px-6 py-2 text-sm text-muted-foreground">No payouts yet.</li>}
            {payouts.map((p) => (
              <li key={p.id} className="flex items-center justify-between px-6 py-2 text-sm">
                <span>{formatPeriod(p.week, timeZone)}</span>
                <span className="text-muted-foreground">{p.convos} convos</span>
                <span className="font-medium">
                  {formatCents(p.amountCents)} <span className="text-xs font-normal text-muted-foreground">{p.status === "SENT" ? "paid" : p.status.toLowerCase()}</span>
                </span>
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>
    </>
  );
}
