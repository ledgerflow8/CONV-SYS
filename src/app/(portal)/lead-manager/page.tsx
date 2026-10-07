import { ChevronDown } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { LiveRefresh } from "@/components/live-refresh";
import { StatCard } from "@/components/stat-card";
import { TopBar } from "@/components/shell/top-bar";
import { requireRole } from "@/lib/auth/session";
import { db } from "@/lib/db";
import { formatCents } from "@/lib/money";
import { scopeFor } from "@/lib/scope";
import { currentPeriods, inWeek, qualifiedTotals, qualifiedTotalsBy, ZERO } from "@/lib/stats";
import { CreateLeadVa, LeadVaPasswordButton } from "./lead-manager-controls";

export default async function LeadManagerDashboard() {
  const user = await requireRole("LEAD_MANAGER");
  const scope = scopeFor(user);
  const { week } = await currentPeriods();

  const [models, leadVas, all, byTeam, byVa] = await Promise.all([
    db.model.findMany({ where: { active: true }, orderBy: { name: "asc" }, select: { id: true, name: true } }),
    db.user.findMany({
      where: { AND: [scope.user, { role: "LEAD_VA", parentId: user.id, status: "ACTIVE" }] },
      orderBy: { username: "asc" },
      select: {
        id: true,
        username: true,
        model: { select: { name: true } },
        children: {
          where: { role: "VA", status: "ACTIVE" },
          orderBy: { username: "asc" },
          select: { id: true, username: true, tgAccount: { select: { username: true } } },
        },
      },
    }),
    qualifiedTotals(user, inWeek(week)),
    qualifiedTotalsBy(user, "leadVaId", inWeek(week)),
    qualifiedTotalsBy(user, "vaId", inWeek(week)),
  ]);
  const vaCount = leadVas.reduce((n, l) => n + l.children.length, 0);

  return (
    <>
      <TopBar title="Dashboard" emoji="📊" />
      <LiveRefresh />

      <div className="mb-4">
        <CreateLeadVa models={models} />
      </div>

      <div className="mb-4 grid grid-cols-2 gap-3">
        <StatCard label="Lead VAs" value={leadVas.length} hint={`${vaCount} VAs underneath`} />
        <StatCard label="Unpaid conversations (all teams, this week)" value={all.convos} />
        <StatCard label="Owed to VAs this week" value={formatCents(all.vaCents)} />
        <StatCard
          label="Payout total this week"
          value={formatCents(all.vaCents + all.leadVaCents)}
          hint={`VAs ${formatCents(all.vaCents)} + Lead VAs ${formatCents(all.leadVaCents)}`}
        />
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Your Lead VAs</CardTitle>
        </CardHeader>
        <CardContent className="px-0">
          <ul className="divide-y">
            {leadVas.length === 0 && <li className="px-6 py-3 text-sm text-muted-foreground">No Lead VAs yet. Create your first one above.</li>}
            {leadVas.map((lva) => {
              const t = byTeam.get(lva.id) ?? ZERO;
              return (
                <li key={lva.id} className="px-6 py-3">
                  <details className="group">
                    <summary className="flex cursor-pointer list-none flex-wrap items-center justify-between gap-2">
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <ChevronDown className="size-4 transition-transform group-open:rotate-180" aria-hidden />
                          <span className="font-medium">@{lva.username}</span>
                          {lva.model && <Badge variant="secondary">{lva.model.name}</Badge>}
                        </div>
                        <p className="pl-6 text-xs text-muted-foreground">
                          {lva.children.length} {lva.children.length === 1 ? "VA" : "VAs"} · {t.convos} this week ·{" "}
                          {formatCents(t.vaCents + t.leadVaCents)} owed
                        </p>
                      </div>
                    </summary>
                    <ul className="mt-2 space-y-1 border-l pl-4 ml-2">
                      {lva.children.length === 0 && <li className="text-xs text-muted-foreground">No VAs yet.</li>}
                      {lva.children.map((va) => (
                        <li key={va.id} className="flex items-center justify-between gap-2 text-sm">
                          <span>
                            @{va.username}
                            <span className="text-xs text-muted-foreground">
                              {" "}
                              · {va.tgAccount ? `@${va.tgAccount.username}` : "no account"}
                            </span>
                          </span>
                          <span className="tabular-nums text-muted-foreground">{byVa.get(va.id)?.convos ?? 0}</span>
                        </li>
                      ))}
                    </ul>
                    <div className="mt-2 pl-6">
                      <LeadVaPasswordButton userId={lva.id} username={lva.username} />
                    </div>
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
