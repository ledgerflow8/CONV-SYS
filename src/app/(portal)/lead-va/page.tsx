import { TriangleAlert } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { LiveRefresh } from "@/components/live-refresh";
import { StatCard, WalletBanner } from "@/components/stat-card";
import { TopBar } from "@/components/shell/top-bar";
import { requireRole } from "@/lib/auth/session";
import { db } from "@/lib/db";
import { formatCents } from "@/lib/money";
import { scopeFor } from "@/lib/scope";
import { getSetting } from "@/lib/settings";
import { currentPeriods, inWeek, poolHealth, qualifiedTotals, qualifiedTotalsBy } from "@/lib/stats";
import { EMPTY_POOL_MESSAGE } from "@/lib/team";
import { AddVaButton, VaRowActions } from "./team-controls";

export default async function LeadVaDashboard() {
  const user = await requireRole("LEAD_VA");
  const scope = scopeFor(user);
  const { week } = await currentPeriods();

  const [model, team, teamWeek, byVa, pool, currency] = await Promise.all([
    user.modelId ? db.model.findUnique({ where: { id: user.modelId }, select: { name: true } }) : null,
    db.user.findMany({
      where: { AND: [scope.user, { role: "VA", parentId: user.id, status: "ACTIVE" }] },
      orderBy: { createdAt: "desc" },
      select: { id: true, username: true, telegramUserId: true, tgAccount: { select: { username: true, status: true } } },
    }),
    qualifiedTotals(user, inWeek(week)),
    qualifiedTotalsBy(user, "vaId", inWeek(week)),
    poolHealth(user),
    getSetting("payoutCurrency"),
  ]);
  const teamPool = pool.find((p) => p.modelId === user.modelId);
  const available = teamPool?.counts.AVAILABLE ?? 0;
  const poolEmpty = available === 0;

  return (
    <>
      <TopBar title="Dashboard" emoji="📊" />
      <LiveRefresh />
      {!user.walletAddress && <WalletBanner currency={currency} />}

      <div className="mb-4 flex items-center gap-2 text-sm">
        <span className="text-muted-foreground">Team model</span>
        <Badge>{model?.name ?? "Not assigned"}</Badge>
      </div>

      <div className="mb-4 grid grid-cols-2 gap-3">
        <StatCard label="Team conversations this week (unpaid)" value={teamWeek.convos} />
        <StatCard label="Your commission this week" value={formatCents(teamWeek.leadVaCents)} tone="good" />
        <StatCard label="My VAs" value={team.length} />
        <StatCard label={`${model?.name ?? "Model"} Telegrams available`} value={available} tone={poolEmpty ? "danger" : undefined} />
      </div>

      <div className="mb-4 space-y-2">
        <AddVaButton poolEmpty={poolEmpty} />
        {poolEmpty && (
          <p role="status" className="flex gap-2 text-sm text-destructive">
            <TriangleAlert className="mt-0.5 size-4 shrink-0" />
            {EMPTY_POOL_MESSAGE}
          </p>
        )}
      </div>

      <Card className="mb-4">
        <CardHeader>
          <CardTitle className="text-base">My Team</CardTitle>
        </CardHeader>
        <CardContent className="px-0">
          <ul className="divide-y">
            {team.length === 0 && <li className="px-6 py-3 text-sm text-muted-foreground">No VAs yet. Add your first one above.</li>}
            {team.map((va) => (
              <li key={va.id} className="space-y-2 px-6 py-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="font-medium">@{va.username}</span>
                      {va.telegramUserId === null ? <Badge variant="outline">Invite pending</Badge> : <Badge variant="secondary">Joined</Badge>}
                    </div>
                    <p className="text-xs text-muted-foreground">
                      {va.tgAccount ? `Account @${va.tgAccount.username}` : "No account assigned"} · {byVa.get(va.id)?.convos ?? 0} qualified
                      this week
                    </p>
                  </div>
                  <VaRowActions vaId={va.id} username={va.username} joined={va.telegramUserId !== null} />
                </div>
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>

      {teamPool && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Telegram pool · {teamPool.name}</CardTitle>
          </CardHeader>
          <CardContent className="grid grid-cols-3 gap-2 text-center">
            {(["AVAILABLE", "ASSIGNED", "BANNED"] as const).map((s) => (
              <div key={s} className="rounded-lg bg-muted/60 py-2">
                <div className="text-lg font-bold">{teamPool.counts[s]}</div>
                <div className="text-xs text-muted-foreground capitalize">{s.toLowerCase()}</div>
              </div>
            ))}
          </CardContent>
        </Card>
      )}
    </>
  );
}
