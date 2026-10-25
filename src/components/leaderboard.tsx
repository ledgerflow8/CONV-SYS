// Weekly leaderboards (server components; the page's LiveRefresh keeps them live).
import { Trophy } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { boardRows, MEDAL, progressLine, standingLine, type PrizeRules, type Ranked } from "@/lib/leaderboard-rank";
import { formatCents } from "@/lib/money";
import { formatPeriod } from "@/lib/time";
import { cn } from "@/lib/utils";

function PrizeBadge({ cents }: { cents: number }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-amber-100 px-2 py-0.5 text-xs font-semibold text-amber-900 dark:bg-amber-900/60 dark:text-amber-100">
      <Trophy className="size-3" aria-hidden />
      {formatCents(cents)}
    </span>
  );
}

// `mine`: highlighted (the viewer, or a Lead Manager's own Lead VAs); `you`: the viewer's own row.
function Row({ r, mine, you = false }: { r: Ranked; mine: boolean; you?: boolean }) {
  const medal = r.convos > 0 ? MEDAL[r.rank - 1] : undefined;
  return (
    <li className={cn("flex items-center gap-3 px-4 py-2.5", mine && "bg-primary/10")} aria-current={mine ? "true" : undefined}>
      <span className="w-7 shrink-0 text-center">
        {medal ? <span className="text-lg" aria-label={`Rank ${r.rank}`}>{medal}</span> : <span className="text-sm tabular-nums text-muted-foreground">{r.rank}</span>}
      </span>
      <div className="min-w-0 flex-1">
        <p className={cn("truncate text-sm", mine ? "font-semibold" : "font-medium")}>
          {r.username}
          {you && <span className="font-normal text-muted-foreground"> (you)</span>}
        </p>
        <p className="text-xs text-muted-foreground tabular-nums">
          {r.convos} {r.convos === 1 ? "convo" : "convos"}
        </p>
      </div>
      <div className="flex shrink-0 flex-col items-end gap-1">
        <span className="text-sm font-semibold tabular-nums">{formatCents(r.cents)}</span>
        {r.prizeCents > 0 && <PrizeBadge cents={r.prizeCents} />}
      </div>
    </li>
  );
}

/**
 * Top 10, plus highlighted rows below them (the viewer; a Lead Manager's own Lead VAs).
 * `full` (Director) puts everyone else behind a "Show all" toggle.
 */
export function LeaderboardCard({
  title,
  ranked,
  highlight = [],
  viewerId,
  rules,
  full = false,
  emptyText,
}: {
  title: string;
  ranked: Ranked[];
  highlight?: string[];
  viewerId?: string;
  rules?: PrizeRules; // with viewerId: shows their progress toward a prize minimum
  full?: boolean;
  emptyText: string;
}) {
  const marked = new Set(highlight);
  const { top, extra } = boardRows(ranked, marked);
  const rest = full ? ranked.slice(top.length) : extra;
  const standing = viewerId ? standingLine(ranked, viewerId) : null;
  const progress = viewerId && rules ? progressLine(ranked, viewerId, rules) : null;

  return (
    <Card className="mb-4 gap-3 pb-0">
      <CardHeader>
        <CardTitle className="text-base">{title}</CardTitle>
        {standing && <CardDescription className="text-foreground">{standing}</CardDescription>}
        {progress && <CardDescription className="font-medium text-amber-700 dark:text-amber-300">{progress}</CardDescription>}
      </CardHeader>
      <CardContent className="px-0">
        {ranked.length === 0 ? (
          <p className="px-6 pb-4 text-sm text-muted-foreground">{emptyText}</p>
        ) : (
          <ul className="divide-y border-t">
            {top.map((r) => (
              <Row key={r.userId} r={r} mine={marked.has(r.userId)} you={r.userId === viewerId} />
            ))}
            {!full && rest.length > 0 && (
              <>
                <li className="px-4 py-1 text-center text-xs text-muted-foreground" aria-hidden>
                  ⋯
                </li>
                {rest.map((r) => (
                  <Row key={r.userId} r={r} mine you={r.userId === viewerId} />
                ))}
              </>
            )}
            {full && rest.length > 0 && (
              <li>
                <details className="group">
                  <summary className="cursor-pointer list-none px-4 py-2.5 text-center text-sm font-medium text-muted-foreground hover:text-foreground">
                    <span className="group-open:hidden">Show all {ranked.length}</span>
                    <span className="hidden group-open:inline">Show top 10</span>
                  </summary>
                  <ul className="divide-y border-t">
                    {rest.map((r) => (
                      <Row key={r.userId} r={r} mine={marked.has(r.userId)} />
                    ))}
                  </ul>
                </details>
              </li>
            )}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

export function PrizesCard({ boards, unit = "convos" }: { boards: { label: string; rules: PrizeRules }[]; unit?: string }) {
  const passDown = boards[0]?.rules.passDown ?? false;
  return (
    <Card className="mb-4 gap-3">
      <CardHeader>
        <CardTitle className="text-base">Prizes this week</CardTitle>
        <CardDescription>
          Added to the winners&apos; payout when the week locks (Monday 00:00).{" "}
          {passDown
            ? "If the person in a prize place is below its minimum, the prize goes to the next person who meets it."
            : "A prize is only paid if the person in that place meets its minimum."}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {boards.map((b) => (
          <div key={b.label}>
            {boards.length > 1 && <p className="mb-1.5 text-xs font-medium text-muted-foreground">{b.label}</p>}
            <div className="grid grid-cols-3 gap-2 text-center">
              {b.rules.prizes.map((cents, i) => {
                const min = b.rules.minConvos[i] ?? 0;
                return (
                  <div key={i} className="rounded-lg bg-muted/60 px-1 py-2">
                    <div className="text-lg">{MEDAL[i]}</div>
                    <div className="font-bold tabular-nums">{cents > 0 ? formatCents(cents) : "—"}</div>
                    {cents > 0 && min > 0 && (
                      <div className="text-xs text-muted-foreground tabular-nums">
                        Min. {min.toLocaleString("en-US")} {unit}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

type PastWeek = {
  id: string;
  startsAt: Date;
  endsAt: Date;
  leaderboardWins: { board: string; rank: number; convos: number; prizeCents: number; user: { username: string } }[];
};

export function PastWinnersCard({ weeks, timeZone }: { weeks: PastWeek[]; timeZone: string }) {
  return (
    <Card className="mb-4">
      <CardHeader>
        <CardTitle className="text-base">Past leaderboard winners</CardTitle>
      </CardHeader>
      <CardContent className="px-0">
        {weeks.length === 0 && <p className="px-6 text-sm text-muted-foreground">Winners appear here once a week locks.</p>}
        <ul className="divide-y">
          {weeks.map((w, i) => (
            <li key={w.id} className="px-6 py-3">
              <details className="group" open={i === 0}>
                <summary className="cursor-pointer list-none text-sm font-medium">{formatPeriod(w, timeZone)}</summary>
                <div className="mt-2 grid gap-3 sm:grid-cols-2">
                  {(["VA", "LEAD_VA"] as const).map((board) => {
                    const wins = w.leaderboardWins.filter((x) => x.board === board);
                    return (
                      <div key={board}>
                        <p className="mb-1 text-xs font-medium text-muted-foreground">{board === "VA" ? "VAs" : "Lead VAs"}</p>
                        {wins.length === 0 && <p className="text-xs text-muted-foreground">No winners.</p>}
                        <ul className="space-y-1">
                          {wins.map((x) => (
                            <li key={x.rank} className="flex items-center justify-between gap-2 text-sm">
                              <span className="min-w-0 truncate">
                                {MEDAL[x.rank - 1]} {x.user.username} <span className="text-xs text-muted-foreground">· {x.convos}</span>
                              </span>
                              {x.prizeCents > 0 && <PrizeBadge cents={x.prizeCents} />}
                            </li>
                          ))}
                        </ul>
                      </div>
                    );
                  })}
                </div>
              </details>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}

/** "incl. $10.00 leaderboard bonus" under a payout amount. */
export function BonusNote({ cents }: { cents: number }) {
  if (cents <= 0) return null;
  return (
    <span className="inline-flex items-center gap-1 text-xs text-amber-700 dark:text-amber-300">
      <Trophy className="size-3" aria-hidden /> incl. {formatCents(cents)} leaderboard bonus
    </span>
  );
}
