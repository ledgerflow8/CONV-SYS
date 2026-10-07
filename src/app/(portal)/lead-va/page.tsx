import { TriangleAlert } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { TopBar } from "@/components/shell/top-bar";
import { requireRole } from "@/lib/auth/session";
import { db } from "@/lib/db";
import { scopeFor } from "@/lib/scope";
import { EMPTY_POOL_MESSAGE } from "@/lib/team";
import { AddVaButton, VaRowActions } from "./team-controls";

export default async function LeadVaDashboard() {
  const user = await requireRole("LEAD_VA");
  const scope = scopeFor(user);

  const [model, available, team] = await Promise.all([
    user.modelId ? db.model.findUnique({ where: { id: user.modelId }, select: { name: true } }) : null,
    db.tgAccount.count({ where: { AND: [scope.tgAccount, { status: "AVAILABLE" }] } }),
    db.user.findMany({
      where: { AND: [scope.user, { role: "VA", parentId: user.id, status: "ACTIVE" }] },
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        username: true,
        telegramUserId: true,
        tgAccount: { select: { username: true, status: true } },
      },
    }),
  ]);
  const poolEmpty = available === 0;

  return (
    <>
      <TopBar title="Dashboard" emoji="📊" />

      {!user.walletAddress && (
        <div className="mb-4 flex gap-2 rounded-xl border border-red-300 bg-red-50 p-3 text-sm text-red-900 dark:border-red-800 dark:bg-red-950 dark:text-red-100">
          <TriangleAlert className="mt-0.5 size-4 shrink-0" />
          <p>
            <strong>Payout address missing.</strong> Add your wallet on the Payouts page so you can get paid.
          </p>
        </div>
      )}

      <div className="mb-4 flex items-center gap-2 text-sm">
        <span className="text-muted-foreground">Team model</span>
        <Badge>{model?.name ?? "Not assigned"}</Badge>
      </div>

      <div className="mb-4 grid grid-cols-2 gap-3">
        <Stat label="My VAs" value={team.length} />
        <Stat label={`${model?.name ?? "Model"} Telegrams available`} value={available} danger={poolEmpty} />
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

      <Card>
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
                      {va.telegramUserId === null ? (
                        <Badge variant="outline">Invite pending</Badge>
                      ) : (
                        <Badge variant="secondary">Joined</Badge>
                      )}
                    </div>
                    <p className="text-xs text-muted-foreground">
                      {va.tgAccount ? `Account @${va.tgAccount.username}` : "No account assigned"}
                    </p>
                  </div>
                  <VaRowActions vaId={va.id} username={va.username} joined={va.telegramUserId !== null} />
                </div>
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>
      <p className="mt-4 text-center text-xs text-muted-foreground">Conversations and commission arrive in Block 7.</p>
    </>
  );
}

function Stat({ label, value, danger }: { label: string; value: number; danger?: boolean }) {
  return (
    <Card className="gap-1 py-4">
      <CardContent className="px-4">
        <div className={danger ? "text-2xl font-bold text-destructive" : "text-2xl font-bold"}>{value}</div>
        <div className="text-xs text-muted-foreground">{label}</div>
      </CardContent>
    </Card>
  );
}
