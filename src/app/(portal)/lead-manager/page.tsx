import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { TopBar } from "@/components/shell/top-bar";
import { requireRole } from "@/lib/auth/session";
import { db } from "@/lib/db";
import { scopeFor } from "@/lib/scope";
import { CreateLeadVa, LeadVaPasswordButton } from "./lead-manager-controls";

export default async function LeadManagerDashboard() {
  const user = await requireRole("LEAD_MANAGER");
  const scope = scopeFor(user);

  const [models, leadVas] = await Promise.all([
    db.model.findMany({ where: { active: true }, orderBy: { name: "asc" }, select: { id: true, name: true } }),
    db.user.findMany({
      where: { AND: [scope.user, { role: "LEAD_VA", parentId: user.id, status: "ACTIVE" }] },
      orderBy: { username: "asc" },
      select: {
        id: true,
        username: true,
        model: { select: { name: true } },
        _count: { select: { children: { where: { role: "VA", status: "ACTIVE" } } } },
      },
    }),
  ]);

  return (
    <>
      <TopBar title="Dashboard" emoji="📊" />

      <div className="mb-4">
        <CreateLeadVa models={models} />
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Your Lead VAs</CardTitle>
        </CardHeader>
        <CardContent className="px-0">
          <ul className="divide-y">
            {leadVas.length === 0 && (
              <li className="px-6 py-3 text-sm text-muted-foreground">No Lead VAs yet. Create your first one above.</li>
            )}
            {leadVas.map((lva) => (
              <li key={lva.id} className="flex flex-wrap items-center justify-between gap-3 px-6 py-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="font-medium">@{lva.username}</span>
                    {lva.model && <Badge variant="secondary">{lva.model.name}</Badge>}
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {lva._count.children} {lva._count.children === 1 ? "VA" : "VAs"}
                  </p>
                </div>
                <LeadVaPasswordButton userId={lva.id} username={lva.username} />
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>
      <p className="mt-4 text-center text-xs text-muted-foreground">Team stats arrive in Block 7.</p>
    </>
  );
}
