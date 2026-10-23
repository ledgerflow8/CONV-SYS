import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { StatusBadge } from "@/components/status-badge";
import { TopBar } from "@/components/shell/top-bar";
import { requireRole } from "@/lib/auth/session";
import { db } from "@/lib/db";
import { scopeFor } from "@/lib/scope";
import { MoveAllTeamsButton, RenameModel } from "@/components/org-controls";
import { AddModelForm, ToggleModelButton } from "./model-controls";

export default async function ModelsPage() {
  const user = await requireRole("DIRECTOR");
  const scope = scopeFor(user);

  const [models, accountCounts, teamCounts] = await Promise.all([
    db.model.findMany({ orderBy: [{ active: "desc" }, { name: "asc" }] }),
    db.tgAccount.groupBy({ by: ["modelId", "status"], where: scope.tgAccount, _count: true }),
    db.user.groupBy({
      by: ["modelId"],
      where: { AND: [scope.user, { role: "LEAD_VA", status: "ACTIVE" }] },
      _count: true,
    }),
  ]);

  const count = (modelId: string, status: string) =>
    accountCounts.find((c) => c.modelId === modelId && c.status === status)?._count ?? 0;
  const teams = (modelId: string) => teamCounts.find((t) => t.modelId === modelId)?._count ?? 0;

  return (
    <>
      <TopBar title="Models" emoji="⭐" />
      <Card className="mb-4">
        <CardHeader>
          <CardTitle className="text-base">Add a model</CardTitle>
        </CardHeader>
        <CardContent>
          <AddModelForm />
        </CardContent>
      </Card>

      <div className="space-y-3">
        {models.length === 0 && <p className="text-sm text-muted-foreground">No models yet.</p>}
        {models.map((m) => (
          <Card key={m.id} className={m.active ? undefined : "opacity-70"}>
            <CardContent className="flex flex-wrap items-center justify-between gap-3">
              <div className="space-y-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-semibold">{m.name}</span>
                  <RenameModel modelId={m.id} name={m.name} />
                  <StatusBadge status={m.active ? "ACTIVE" : "INACTIVE"} />
                </div>
                <p className="text-sm text-muted-foreground">
                  {teams(m.id)} {teams(m.id) === 1 ? "team" : "teams"} · {count(m.id, "AVAILABLE")} available ·{" "}
                  {count(m.id, "ASSIGNED")} assigned · {count(m.id, "BANNED")} banned
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                {teams(m.id) > 0 && (
                  <MoveAllTeamsButton fromModel={{ id: m.id, name: m.name }} models={models.filter((x) => x.active).map((x) => ({ id: x.id, name: x.name }))} />
                )}
                <ToggleModelButton modelId={m.id} active={m.active} name={m.name} />
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
    </>
  );
}
