import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, Download, TriangleAlert } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { StatCard } from "@/components/stat-card";
import { StatusBadge } from "@/components/status-badge";
import { TopBar } from "@/components/shell/top-bar";
import { requireRole } from "@/lib/auth/session";
import { ROLE_LABEL } from "@/lib/auth/roles";
import { db } from "@/lib/db";
import { formatCents } from "@/lib/money";
import { scopeFor } from "@/lib/scope";
import { getSetting } from "@/lib/settings";
import { qualifiedTotals } from "@/lib/stats";
import { formatDateTime, formatPeriod } from "@/lib/time";
import { LockWeekButton, PayoutRowActions } from "../payout-controls";

export default async function WeekPayoutsPage({ params }: { params: Promise<{ weekId: string }> }) {
  const user = await requireRole("DIRECTOR");
  const { weekId } = await params;
  const week = await db.week.findUnique({ where: { id: weekId } });
  if (!week) notFound();
  const [timeZone, currency, payouts, preview] = await Promise.all([
    getSetting("timezone"),
    getSetting("payoutCurrency"),
    db.payout.findMany({
      where: { AND: [scopeFor(user).payout, { weekId }] },
      orderBy: [{ role: "asc" }, { amountCents: "desc" }],
      include: { user: { select: { username: true, walletAddress: true, status: true } } },
    }),
    qualifiedTotals(user, { weekId }),
  ]);
  const ended = week.endsAt <= new Date();
  const total = payouts.reduce((n, p) => n + p.amountCents, 0);
  const paid = payouts.filter((p) => p.status === "SENT").reduce((n, p) => n + p.amountCents, 0);
  const missing = payouts.filter((p) => !p.walletAddress).length;

  return (
    <>
      <TopBar title="Payouts" emoji="💸" />
      <Link href="/director/payouts" className="mb-3 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="size-4" /> All weeks
      </Link>

      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <h2 className="text-lg font-semibold">{formatPeriod(week, timeZone)}</h2>
          <StatusBadge status={week.status} />
        </div>
        <div className="flex flex-wrap gap-2">
          {week.status === "OPEN" && ended && <LockWeekButton weekId={week.id} />}
          {week.status !== "OPEN" && (
            <a
              href={`/director/payouts/${week.id}/export`}
              className="inline-flex h-9 items-center gap-2 rounded-md border bg-background px-3 text-sm font-medium hover:bg-muted"
            >
              <Download className="size-4" /> Export CSV
            </a>
          )}
        </div>
      </div>

      {week.status === "OPEN" ? (
        <Card>
          <CardContent className="space-y-1 py-2 text-sm">
            <p>
              {ended ? "This week has finished and is waiting to be locked." : "This week is still open."} So far:{" "}
              <strong>{preview.convos}</strong> qualified convos,{" "}
              <strong>{formatCents(preview.vaCents + preview.leadVaCents + preview.lmCents)}</strong> owed.
            </p>
            <p className="text-muted-foreground">Payouts are generated when the week locks.</p>
          </CardContent>
        </Card>
      ) : (
        <>
          <div className="mb-4 grid grid-cols-3 gap-3">
            <StatCard label={`Total (${currency})`} value={formatCents(total)} />
            <StatCard label="Paid" value={formatCents(paid)} tone={paid === total && total > 0 ? "good" : undefined} />
            <StatCard label="Missing wallets" value={missing} tone={missing ? "danger" : undefined} />
          </div>
          <Card className="py-0">
            <ul className="divide-y">
              {payouts.length === 0 && <li className="p-4 text-sm text-muted-foreground">No earnings this week.</li>}
              {payouts.map((p) => (
                <li key={p.id} className="space-y-2 px-4 py-3">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="font-medium">
                        @{p.user.username}{" "}
                        <span className="text-xs font-normal text-muted-foreground">
                          {ROLE_LABEL[p.role]} · {p.convos} convos
                          {p.user.status !== "ACTIVE" && ` · ${p.user.status.toLowerCase()}`}
                        </span>
                      </p>
                      {p.walletAddress ? (
                        <p className="font-mono text-xs break-all text-muted-foreground">{p.walletAddress}</p>
                      ) : (
                        <p className="flex items-center gap-1 text-xs text-destructive">
                          <TriangleAlert className="size-3" /> No wallet
                          {p.user.walletAddress && " (they've added one since: use it below)"}
                        </p>
                      )}
                      {p.txHash && (
                        <p className="font-mono text-xs break-all text-muted-foreground">
                          tx {p.txHash}
                          {p.paidAt && ` · ${formatDateTime(p.paidAt, timeZone)}`}
                        </p>
                      )}
                    </div>
                    <div className="flex shrink-0 flex-col items-end gap-1">
                      <span className="font-semibold tabular-nums">{formatCents(p.amountCents)}</span>
                      <StatusBadge status={p.status} />
                    </div>
                  </div>
                  {p.status !== "SENT" && (
                    <PayoutRowActions
                      payoutId={p.id}
                      status={p.status}
                      hasWallet={!!p.walletAddress}
                      canUseCurrentWallet={!!p.user.walletAddress && p.user.walletAddress !== p.walletAddress}
                    />
                  )}
                </li>
              ))}
            </ul>
          </Card>
        </>
      )}
    </>
  );
}
