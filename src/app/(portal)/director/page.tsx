import Link from "next/link";
import { ChevronDown } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { LiveRefresh } from "@/components/live-refresh";
import { StatCard } from "@/components/stat-card";
import { TopBar } from "@/components/shell/top-bar";
import { requireRole } from "@/lib/auth/session";
import { db } from "@/lib/db";
import { formatCents } from "@/lib/money";
import { scopeFor } from "@/lib/scope";
import {
  activeVaCount,
  currentPeriods,
  inWeek,
  poolHealth,
  qualifiedBetween,
  qualifiedTotals,
  qualifiedTotalsBy,
  reviewCount,
  ZERO,
} from "@/lib/stats";
import { formatPeriod } from "@/lib/time";
import { cn } from "@/lib/utils";

export default async function DirectorOverview() {
  const user = await requireRole("DIRECTOR");
  const scope = scopeFor(user);
  const { week, today, timeZone } = await currentPeriods();

  const [todayTotals, weekTotals, byLm, byLva, activeVas, pool, inReview, lms] = await Promise.all([
    qualifiedTotals(user, qualifiedBetween(today)),
    qualifiedTotals(user, inWeek(week)),
    qualifiedTotalsBy(user, "leadManagerId", inWeek(week)),
    qualifiedTotalsBy(user, "leadVaId", inWeek(week)),
    activeVaCount(user),
    poolHealth(user),
    reviewCount(user),
    db.user.findMany({
      where: { AND: [scope.user, { role: "LEAD_MANAGER" }] },
      orderBy: [{ status: "asc" }, { username: "asc" }],
      select: {
        id: true,
        username: true,
        status: true,
        children: { where: { role: "LEAD_VA" }, orderBy: { username: "asc" }, select: { id: true, username: true, status: true } },
      },
    }),
  ]);
  const owedTotal = weekTotals.vaCents + weekTotals.leadVaCents + weekTotals.lmCents;

  return (
    <>
      <TopBar title="Overview" emoji="📊" />
      <LiveRefresh />

      <div className="mb-4 grid grid-cols-2 gap-3">
        <StatCard label="Qualified today" value={todayTotals.convos} />
        <StatCard label="Qualified this week" value={weekTotals.convos} hint={formatPeriod(week, timeZone)} />
        <StatCard label="Active VAs" value={activeVas} />
        <StatCard
          label="Convos in review"
          value={<Link href="/director/convos" className="hover:underline">{inReview}</Link>}
          tone={inReview > 0 ? "danger" : undefined}
        />
      </div>

      <Card className="mb-4">
        <CardHeader>
          <CardTitle className="text-base">Owed this week · {formatCents(owedTotal)}</CardTitle>
        </CardHeader>
        <CardContent className="grid grid-cols-3 gap-2 text-center">
          {[
            ["VAs", weekTotals.vaCents],
            ["Lead VAs", weekTotals.leadVaCents],
            ["Lead Managers", weekTotals.lmCents],
          ].map(([label, cents]) => (
            <div key={label as string} className="rounded-lg bg-muted/60 py-2">
              <div className="text-lg font-bold tabular-nums">{formatCents(cents as number)}</div>
              <div className="text-xs text-muted-foreground">{label}</div>
            </div>
          ))}
        </CardContent>
      </Card>

      <Card className="mb-4">
        <CardHeader>
          <CardTitle className="text-base">Pool health</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          {pool.length === 0 && <p className="text-sm text-muted-foreground">No models yet.</p>}
          {pool.map((m) => (
            <div key={m.modelId} className={cn("flex items-center justify-between gap-2 text-sm", !m.active && "opacity-60")}>
              <span className="font-medium">{m.name}</span>
              <span className="tabular-nums text-muted-foreground">
                <span className={m.counts.AVAILABLE === 0 ? "font-semibold text-destructive" : undefined}>{m.counts.AVAILABLE} available</span> ·{" "}
                {m.counts.ASSIGNED} assigned · {m.counts.BANNED} banned
              </span>
            </div>
          ))}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">By Lead Manager · this week</CardTitle>
        </CardHeader>
        <CardContent className="px-0">
          <ul className="divide-y">
            {lms.length === 0 && <li className="px-6 py-3 text-sm text-muted-foreground">No Lead Managers yet.</li>}
            {lms.map((lm) => {
              const t = byLm.get(lm.id) ?? ZERO;
              return (
                <li key={lm.id} className="px-6 py-3">
                  <details className="group">
                    <summary className="flex cursor-pointer list-none items-center justify-between gap-2">
                      <span className="flex items-center gap-2 font-medium">
                        <ChevronDown className="size-4 transition-transform group-open:rotate-180" aria-hidden />@{lm.username}
                        {lm.status !== "ACTIVE" && <span className="text-xs text-muted-foreground">({lm.status.toLowerCase()})</span>}
                      </span>
                      <span className="text-sm tabular-nums text-muted-foreground">
                        {t.convos} · {formatCents(t.vaCents + t.leadVaCents + t.lmCents)}
                      </span>
                    </summary>
                    <ul className="mt-2 ml-2 space-y-1 border-l pl-4">
                      {lm.children.length === 0 && <li className="text-xs text-muted-foreground">No Lead VAs yet.</li>}
                      {lm.children.map((lva) => {
                        const lt = byLva.get(lva.id) ?? ZERO;
                        return (
                          <li key={lva.id} className="flex items-center justify-between gap-2 text-sm">
                            <span>@{lva.username}</span>
                            <span className="tabular-nums text-muted-foreground">
                              {lt.convos} · {formatCents(lt.vaCents + lt.leadVaCents)}
                            </span>
                          </li>
                        );
                      })}
                    </ul>
                  </details>
                </li>
              );
            })}
          </ul>
        </CardContent>
      </Card>
    </>
  );
}
