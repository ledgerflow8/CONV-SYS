import Link from "next/link";
import type { Prisma, TgStatus } from "@prisma/client";
import { Card, CardContent } from "@/components/ui/card";
import { StatusBadge } from "@/components/status-badge";
import { TopBar } from "@/components/shell/top-bar";
import { requireRole } from "@/lib/auth/session";
import { db } from "@/lib/db";
import { scopeFor } from "@/lib/scope";
import { cn } from "@/lib/utils";
import { AddAccountDialog, ImportAccountsDialog } from "./pool-controls";

const STATUSES: TgStatus[] = ["AVAILABLE", "ASSIGNED", "BANNED", "RETIRED"];
const LIST_LIMIT = 200;

export default async function PoolPage({
  searchParams,
}: {
  searchParams: Promise<{ model?: string; status?: string; q?: string }>;
}) {
  const user = await requireRole("DIRECTOR");
  const scope = scopeFor(user);
  const sp = await searchParams;
  const status = STATUSES.find((s) => s === sp.status);
  const q = sp.q?.trim().replace(/^@/, "").slice(0, 64);

  const models = await db.model.findMany({ orderBy: { name: "asc" }, select: { id: true, name: true, active: true } });
  const modelId = models.find((m) => m.id === sp.model)?.id;

  const where: Prisma.TgAccountWhereInput = {
    AND: [
      scope.tgAccount,
      modelId ? { modelId } : {},
      status ? { status } : {},
      q ? { OR: [{ username: { contains: q, mode: "insensitive" } }, { phone: { contains: q } }] } : {},
    ],
  };

  const [counts, accounts, total] = await Promise.all([
    db.tgAccount.groupBy({ by: ["modelId", "status"], where: scope.tgAccount, _count: true }),
    db.tgAccount.findMany({
      where,
      orderBy: [{ status: "asc" }, { username: "asc" }],
      take: LIST_LIMIT,
      select: {
        id: true,
        username: true,
        phone: true,
        link: true,
        status: true,
        model: { select: { name: true } },
        va: { select: { username: true } },
      },
    }),
    db.tgAccount.count({ where }),
  ]);

  const count = (m: string, s: TgStatus) => counts.find((c) => c.modelId === m && c.status === s)?._count ?? 0;
  const href = (next: { model?: string; status?: string }) => {
    const p = new URLSearchParams();
    const m = "model" in next ? next.model : modelId;
    const s = "status" in next ? next.status : status;
    if (m) p.set("model", m);
    if (s) p.set("status", s);
    if (q) p.set("q", q);
    const qs = p.toString();
    return qs ? `/director/pool?${qs}` : "/director/pool";
  };
  const activeModels = models.filter((m) => m.active);

  return (
    <>
      <TopBar title="Telegram Pool" emoji="📱" />

      <div className="mb-4 flex flex-wrap gap-2">
        <AddAccountDialog models={activeModels} />
        <ImportAccountsDialog models={activeModels} />
      </div>

      <div className="mb-4 grid gap-3 sm:grid-cols-2">
        {models.map((m) => (
          <Card key={m.id} className={m.active ? undefined : "opacity-70"}>
            <CardContent className="space-y-2">
              <div className="flex items-center justify-between">
                <span className="font-semibold">{m.name}</span>
                {!m.active && <StatusBadge status="INACTIVE" />}
              </div>
              <div className="grid grid-cols-3 gap-2 text-center">
                {(["AVAILABLE", "ASSIGNED", "BANNED"] as const).map((s) => (
                  <Link key={s} href={href({ model: m.id, status: s })} className="rounded-lg bg-muted/60 py-2 hover:bg-muted">
                    <div className={cn("text-lg font-bold", s === "AVAILABLE" && count(m.id, s) === 0 && "text-destructive")}>
                      {count(m.id, s)}
                    </div>
                    <div className="text-xs text-muted-foreground capitalize">{s.toLowerCase()}</div>
                  </Link>
                ))}
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      <form className="mb-3 flex gap-2" action="/director/pool">
        {modelId && <input type="hidden" name="model" value={modelId} />}
        {status && <input type="hidden" name="status" value={status} />}
        <input
          name="q"
          defaultValue={q}
          placeholder="Search username or phone"
          aria-label="Search accounts"
          className="h-9 min-w-0 flex-1 rounded-md border bg-background px-3 text-sm"
        />
        <button className="h-9 rounded-md border bg-background px-3 text-sm font-medium">Search</button>
      </form>

      <div className="mb-3 flex flex-wrap gap-1.5 text-sm">
        <Chip href={href({ model: undefined })} active={!modelId}>
          All models
        </Chip>
        {models.map((m) => (
          <Chip key={m.id} href={href({ model: m.id })} active={modelId === m.id}>
            {m.name}
          </Chip>
        ))}
        <span className="mx-1 text-muted-foreground">|</span>
        <Chip href={href({ status: undefined })} active={!status}>
          Any status
        </Chip>
        {STATUSES.map((s) => (
          <Chip key={s} href={href({ status: s })} active={status === s}>
            {s.toLowerCase()}
          </Chip>
        ))}
      </div>

      <p className="mb-2 text-sm text-muted-foreground">
        {total} {total === 1 ? "account" : "accounts"}
        {total > LIST_LIMIT && ` · showing first ${LIST_LIMIT}`}
      </p>
      <Card className="py-0">
        <ul className="divide-y">
          {accounts.length === 0 && <li className="p-4 text-sm text-muted-foreground">No accounts match.</li>}
          {accounts.map((a) => (
            <li key={a.id} className="flex items-center justify-between gap-3 px-4 py-3">
              <div className="min-w-0">
                <a href={a.link} target="_blank" rel="noopener noreferrer" className="font-medium hover:underline">
                  @{a.username}
                </a>
                <p className="truncate text-xs text-muted-foreground">
                  {a.model.name} · {a.phone}
                  {a.va && ` · held by @${a.va.username}`}
                </p>
              </div>
              <StatusBadge status={a.status} />
            </li>
          ))}
        </ul>
      </Card>
    </>
  );
}

function Chip({ href, active, children }: { href: string; active: boolean; children: React.ReactNode }) {
  return (
    <Link
      href={href}
      className={cn(
        "rounded-full border px-3 py-1 capitalize",
        active ? "border-primary bg-primary text-primary-foreground" : "bg-background hover:bg-muted",
      )}
    >
      {children}
    </Link>
  );
}
