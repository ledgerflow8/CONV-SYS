import type { Prisma, Role } from "@prisma/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { StatusBadge } from "@/components/status-badge";
import { TopBar } from "@/components/shell/top-bar";
import { ROLE_LABEL, ROLES } from "@/lib/auth/roles";
import { requireRole } from "@/lib/auth/session";
import { db } from "@/lib/db";
import { scopeFor } from "@/lib/scope";
import { CreateLeadManager, LeadManagerActions } from "./people-controls";

const DIRECTORY_LIMIT = 100;

export default async function PeoplePage({ searchParams }: { searchParams: Promise<{ q?: string; role?: string }> }) {
  const user = await requireRole("DIRECTOR");
  const scope = scopeFor(user);
  const sp = await searchParams;
  const q = sp.q?.trim().replace(/^@/, "").slice(0, 64);
  const role = ROLES.find((r) => r === sp.role) as Role | undefined;

  const directoryWhere: Prisma.UserWhereInput = {
    AND: [
      scope.user,
      role ? { role } : {},
      q
        ? {
            OR: [
              { username: { contains: q, mode: "insensitive" } },
              { telegramHandle: { contains: q, mode: "insensitive" } },
            ],
          }
        : {},
    ],
  };

  const [leadManagers, directory, directoryTotal] = await Promise.all([
    db.user.findMany({
      where: { AND: [scope.user, { role: "LEAD_MANAGER" }] },
      orderBy: [{ status: "asc" }, { username: "asc" }],
      select: {
        id: true,
        username: true,
        status: true,
        createdAt: true,
        _count: { select: { children: { where: { role: "LEAD_VA", status: "ACTIVE" } } } },
      },
    }),
    db.user.findMany({
      where: directoryWhere,
      orderBy: [{ role: "asc" }, { username: "asc" }],
      take: DIRECTORY_LIMIT,
      select: {
        id: true,
        username: true,
        role: true,
        status: true,
        telegramHandle: true,
        parent: { select: { username: true } },
        model: { select: { name: true } },
      },
    }),
    db.user.count({ where: directoryWhere }),
  ]);

  return (
    <>
      <TopBar title="People" emoji="👥" />

      <Card className="mb-6">
        <CardHeader className="flex flex-row items-center justify-between gap-3">
          <CardTitle className="text-base">Lead Managers</CardTitle>
          <CreateLeadManager />
        </CardHeader>
        <CardContent className="px-0">
          <ul className="divide-y">
            {leadManagers.length === 0 && <li className="px-6 py-3 text-sm text-muted-foreground">No Lead Managers yet.</li>}
            {leadManagers.map((lm) => (
              <li key={lm.id} className="flex flex-wrap items-center justify-between gap-3 px-6 py-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="font-medium">@{lm.username}</span>
                    {lm.status !== "ACTIVE" && <StatusBadge status={lm.status} />}
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {lm._count.children} Lead {lm._count.children === 1 ? "VA" : "VAs"}
                  </p>
                </div>
                <LeadManagerActions userId={lm.id} username={lm.username} status={lm.status} />
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>

      <h2 className="mb-2 text-lg font-semibold">Directory</h2>
      <form className="mb-3 flex flex-wrap gap-2" action="/director/people">
        <input
          name="q"
          defaultValue={q}
          placeholder="Search username or Telegram"
          aria-label="Search people"
          className="h-9 min-w-0 flex-1 rounded-md border bg-background px-3 text-sm"
        />
        <select
          name="role"
          defaultValue={role ?? ""}
          aria-label="Role"
          className="h-9 rounded-md border bg-background px-2 text-sm"
        >
          <option value="">All roles</option>
          {ROLES.map((r) => (
            <option key={r} value={r}>
              {ROLE_LABEL[r]}
            </option>
          ))}
        </select>
        <button className="h-9 rounded-md border bg-background px-3 text-sm font-medium">Search</button>
      </form>

      <p className="mb-2 text-sm text-muted-foreground">
        {directoryTotal} {directoryTotal === 1 ? "person" : "people"}
        {directoryTotal > DIRECTORY_LIMIT && ` · showing first ${DIRECTORY_LIMIT}`}
      </p>
      <Card className="py-0">
        <ul className="divide-y">
          {directory.length === 0 && <li className="p-4 text-sm text-muted-foreground">Nobody matches.</li>}
          {directory.map((p) => (
            <li key={p.id} className="flex items-center justify-between gap-3 px-4 py-3">
              <div className="min-w-0">
                <span className="font-medium">@{p.username}</span>
                <p className="truncate text-xs text-muted-foreground">
                  {ROLE_LABEL[p.role]}
                  {p.model && ` · ${p.model.name}`}
                  {p.parent && ` · under @${p.parent.username}`}
                  {p.telegramHandle && ` · TG @${p.telegramHandle}`}
                </p>
              </div>
              <StatusBadge status={p.status} />
            </li>
          ))}
        </ul>
      </Card>
    </>
  );
}
