import Link from "next/link";
import type { ConvoStatus, Prisma } from "@prisma/client";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { StatusBadge } from "@/components/status-badge";
import { TopBar } from "@/components/shell/top-bar";
import { requireRole } from "@/lib/auth/session";
import { db } from "@/lib/db";
import { scopeFor } from "@/lib/scope";
import { getSetting } from "@/lib/settings";
import { formatDateTime } from "@/lib/time";
import { cn } from "@/lib/utils";
import { ImportConvosDialog, ReviewActions } from "./convo-controls";

const STATUSES: ConvoStatus[] = ["QUALIFIED", "PENDING", "REVIEW", "REJECTED"];
const LIST_LIMIT = 100;

const REASON_LABEL: Record<string, string> = {
  unknown_country: "Country unknown",
  unknown_account: "Account not in pool",
  unattributed: "No VA held the account",
  non_tier1: "Not Tier 1",
  blocked_source: "Blocked source",
  review_rejected: "Rejected in review",
};

const convoSelect = {
  id: true,
  accountRef: true,
  peerId: true,
  country: true,
  countrySource: true,
  source: true,
  status: true,
  rejectReason: true,
  reviewReason: true,
  firstMsgAt: true,
  repliedAt: true,
  va: { select: { username: true } },
} satisfies Prisma.ConvoSelect;

export default async function ConvosPage({ searchParams }: { searchParams: Promise<{ status?: string; q?: string }> }) {
  const user = await requireRole("DIRECTOR");
  const scope = scopeFor(user);
  const sp = await searchParams;
  const status = STATUSES.find((s) => s === sp.status);
  const q = sp.q?.trim().replace(/^@/, "").slice(0, 64);
  const tz = await getSetting("timezone");

  const listWhere: Prisma.ConvoWhereInput = {
    AND: [
      scope.convo,
      status ? { status } : {},
      q
        ? {
            OR: [
              { peerId: { contains: q } },
              { accountRef: { contains: q.toLowerCase() } },
              { va: { username: { contains: q, mode: "insensitive" } } },
            ],
          }
        : {},
    ],
  };

  const [review, reviewCount, list, total, counts] = await Promise.all([
    db.convo.findMany({ where: { AND: [scope.convo, { status: "REVIEW" }] }, orderBy: { firstMsgAt: "asc" }, take: 50, select: convoSelect }),
    db.convo.count({ where: { AND: [scope.convo, { status: "REVIEW" }] } }),
    db.convo.findMany({ where: listWhere, orderBy: { firstMsgAt: "desc" }, take: LIST_LIMIT, select: convoSelect }),
    db.convo.count({ where: listWhere }),
    db.convo.groupBy({ by: ["status"], where: scope.convo, _count: true }),
  ]);
  const countOf = (s: ConvoStatus) => counts.find((c) => c.status === s)?._count ?? 0;
  const href = (s?: ConvoStatus) => {
    const p = new URLSearchParams();
    if (s) p.set("status", s);
    if (q) p.set("q", q);
    return p.size ? `/director/convos?${p}` : "/director/convos";
  };

  return (
    <>
      <TopBar title="Convos" emoji="💬" />

      <div className="mb-4">
        <ImportConvosDialog />
      </div>

      <Card className="mb-6">
        <CardHeader>
          <CardTitle className="text-base">Review queue · {reviewCount}</CardTitle>
          <CardDescription>
            Approve or reject convos with an unknown country. For missing accounts or unassigned holders, fix the pool, then Retry.
          </CardDescription>
        </CardHeader>
        <CardContent className="px-0">
          <ul className="divide-y">
            {review.length === 0 && <li className="px-6 py-3 text-sm text-muted-foreground">Nothing to review.</li>}
            {review.map((c) => (
              <li key={c.id} className="space-y-2 px-6 py-3">
                <ConvoLine c={c} tz={tz} />
                <ReviewActions convoId={c.id} canApprove={c.reviewReason === "unknown_country"} />
              </li>
            ))}
          </ul>
          {reviewCount > review.length && (
            <p className="px-6 pt-2 text-xs text-muted-foreground">Showing the oldest {review.length} of {reviewCount}.</p>
          )}
        </CardContent>
      </Card>

      <h2 className="mb-2 text-lg font-semibold">All convos</h2>
      <form className="mb-3 flex gap-2" action="/director/convos">
        {status && <input type="hidden" name="status" value={status} />}
        <input
          name="q"
          defaultValue={q}
          placeholder="Search peer id, account or VA"
          aria-label="Search convos"
          className="h-9 min-w-0 flex-1 rounded-md border bg-background px-3 text-sm"
        />
        <button className="h-9 rounded-md border bg-background px-3 text-sm font-medium">Search</button>
      </form>
      <div className="mb-3 flex flex-wrap gap-1.5 text-sm">
        <Chip href={href()} active={!status}>
          All
        </Chip>
        {STATUSES.map((s) => (
          <Chip key={s} href={href(s)} active={status === s}>
            {s.toLowerCase()} · {countOf(s)}
          </Chip>
        ))}
      </div>
      <p className="mb-2 text-sm text-muted-foreground">
        {total} {total === 1 ? "convo" : "convos"}
        {total > LIST_LIMIT && ` · showing newest ${LIST_LIMIT}`}
      </p>
      <Card className="py-0">
        <ul className="divide-y">
          {list.length === 0 && <li className="p-4 text-sm text-muted-foreground">No convos match.</li>}
          {list.map((c) => (
            <li key={c.id} className="px-4 py-3">
              <ConvoLine c={c} tz={tz} />
            </li>
          ))}
        </ul>
      </Card>
    </>
  );
}

function ConvoLine({ c, tz }: { c: Prisma.ConvoGetPayload<{ select: typeof convoSelect }>; tz: string }) {
  const reason = c.rejectReason ?? c.reviewReason;
  return (
    <div className="flex items-start justify-between gap-3">
      <div className="min-w-0 space-y-0.5">
        <p className="truncate text-sm font-medium">
          @{c.accountRef} · peer {c.peerId}
        </p>
        <p className="truncate text-xs text-muted-foreground">
          {c.va ? `VA @${c.va.username}` : "No VA"} · {c.country ?? "??"}
          {c.country && ` (${c.countrySource.toLowerCase()})`}
          {c.source && ` · ${c.source}`}
        </p>
        <p className="text-xs text-muted-foreground">
          First {formatDateTime(c.firstMsgAt, tz)}
          {c.repliedAt ? ` · replied ${formatDateTime(c.repliedAt, tz)}` : " · no reply yet"}
        </p>
      </div>
      <div className="flex shrink-0 flex-col items-end gap-1">
        <StatusBadge status={c.status} />
        {reason && <span className="text-xs text-muted-foreground">{REASON_LABEL[reason] ?? reason}</span>}
      </div>
    </div>
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
