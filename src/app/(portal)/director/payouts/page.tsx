import Link from "next/link";
import { ChevronRight } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { StatCard } from "@/components/stat-card";
import { StatusBadge } from "@/components/status-badge";
import { TopBar } from "@/components/shell/top-bar";
import { requireRole } from "@/lib/auth/session";
import { db } from "@/lib/db";
import { formatCents } from "@/lib/money";
import { scopeFor } from "@/lib/scope";
import { currentPeriods, inWeek, qualifiedTotals } from "@/lib/stats";
import { formatDay, formatPeriod } from "@/lib/time";
import { LockFinishedWeeksButton } from "./payout-controls";

export default async function DirectorPayoutsPage() {
  const user = await requireRole("DIRECTOR");
  const scope = scopeFor(user);
  const { week, timeZone } = await currentPeriods();

  const [current, weeks, convoSums, payoutSums] = await Promise.all([
    qualifiedTotals(user, inWeek(week)),
    db.week.findMany({ orderBy: { startsAt: "desc" }, take: 26 }),
    db.convo.groupBy({
      by: ["weekId"],
      where: { AND: [scope.convo, { status: "QUALIFIED" }] },
      _count: true,
      _sum: { vaCents: true, leadVaCents: true, lmCents: true },
    }),
    db.payout.groupBy({ by: ["weekId", "status"], where: scope.payout, _count: true, _sum: { amountCents: true } }),
  ]);
  const now = new Date();
  const dueToLock = weeks.filter((w) => w.status === "OPEN" && w.endsAt <= now).length;

  return (
    <>
      <TopBar title="Payouts" emoji="💸" />

      <div className="mb-4 grid grid-cols-2 gap-3">
        <StatCard label="This week so far" value={formatCents(current.vaCents + current.leadVaCents + current.lmCents)} hint={`${current.convos} convos · ${formatPeriod(week, timeZone)}`} />
        <StatCard label="Locks automatically" value={formatDay(week.endsAt, timeZone)} hint="Monday 00:00, then payouts are generated" />
      </div>

      <div className="mb-4 flex flex-wrap items-center gap-3">
        <LockFinishedWeeksButton due={dueToLock} />
        <p className="text-sm text-muted-foreground">
          {dueToLock ? `${dueToLock} finished week${dueToLock > 1 ? "s" : ""} waiting to lock.` : "Nothing waiting to lock."}
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Weeks</CardTitle>
        </CardHeader>
        <CardContent className="px-0">
          <ul className="divide-y">
            {weeks.length === 0 && <li className="px-6 py-3 text-sm text-muted-foreground">No weeks yet.</li>}
            {weeks.map((w) => {
              const c = convoSums.find((x) => x.weekId === w.id);
              const owed = c ? (c._sum.vaCents ?? 0) + (c._sum.leadVaCents ?? 0) + (c._sum.lmCents ?? 0) : 0;
              const rows = payoutSums.filter((p) => p.weekId === w.id);
              const total = rows.reduce((n, r) => n + r._count, 0);
              const sent = rows.filter((r) => r.status === "SENT").reduce((n, r) => n + r._count, 0);
              return (
                <li key={w.id}>
                  <Link href={`/director/payouts/${w.id}`} className="flex items-center justify-between gap-3 px-6 py-3 hover:bg-muted/50">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="font-medium">{formatPeriod(w, timeZone)}</span>
                        <StatusBadge status={w.status} />
                      </div>
                      <p className="text-xs text-muted-foreground">
                        {c?._count ?? 0} convos · {formatCents(owed)}
                        {w.status !== "OPEN" && ` · ${sent}/${total} paid`}
                      </p>
                    </div>
                    <ChevronRight className="size-4 text-muted-foreground" />
                  </Link>
                </li>
              );
            })}
          </ul>
        </CardContent>
      </Card>
    </>
  );
}
