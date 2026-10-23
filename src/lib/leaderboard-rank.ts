// Weekly leaderboard ranking (pure; safe to import on the client). Loading lives in leaderboard.ts.
export type Board = "VA" | "LEAD_VA";

export type BoardEntry = {
  userId: string;
  username: string;
  convos: number; // qualified convos this week: the same count earnings are paid on
  cents: number; // what those convos earned them (snapshotted rates)
  reachedAt: Date | null; // when they reached `convos` (their latest qualified convo)
};

export type Ranked = BoardEntry & { rank: number; prizeCents: number };

export const PRIZE_PLACES = 3;
export const MEDAL = ["🥇", "🥈", "🥉"] as const;

/**
 * Most convos first. Ties: whoever reached the count first ranks higher. Ranks are always distinct.
 * Only someone with at least one convo can win a prize.
 */
export function rankBoard(entries: BoardEntry[], prizes: readonly number[]): Ranked[] {
  const time = (d: Date | null) => d?.getTime() ?? Number.POSITIVE_INFINITY;
  return [...entries]
    .sort((a, b) => b.convos - a.convos || time(a.reachedAt) - time(b.reachedAt) || a.username.localeCompare(b.username))
    .map((e, i) => ({ ...e, rank: i + 1, prizeCents: e.convos > 0 && i < PRIZE_PLACES ? (prizes[i] ?? 0) : 0 }));
}

/** The top `limit` rows, plus any highlighted rows (the viewer, a Lead Manager's teams) below them. */
export function boardRows(ranked: Ranked[], highlight: ReadonlySet<string>, limit = 10) {
  return { top: ranked.slice(0, limit), extra: ranked.slice(limit).filter((r) => highlight.has(r.userId)) };
}

export function ordinal(n: number): string {
  const s = n % 100 >= 11 && n % 100 <= 13 ? "th" : ({ 1: "st", 2: "nd", 3: "rd" } as Record<number, string>)[n % 10] ?? "th";
  return `${n}${s}`;
}

const convos = (n: number) => `${n} conversation${n === 1 ? "" : "s"}`;

/** "3 conversations behind anna_VA in 2nd" — the viewer's gap to the place above them. */
export function standingLine(ranked: Ranked[], userId: string): string | null {
  const i = ranked.findIndex((r) => r.userId === userId);
  if (i < 0) return null;
  const me = ranked[i];
  if (me.convos === 0) {
    // Everyone on zero is level; the useful gap is to the last person who has scored.
    const scorer = ranked.findLast((r) => r.convos > 0);
    return scorer ? `${convos(scorer.convos)} behind ${scorer.username} in ${ordinal(scorer.rank)}.` : "No conversations yet this week.";
  }
  if (i === 0) {
    const next = ranked[1];
    if (!next || next.convos === 0) return "You're in 1st place.";
    const lead = me.convos - next.convos;
    return lead === 0
      ? `You're in 1st place, level with ${next.username} but you got there first.`
      : `You're in 1st place, ${convos(lead)} ahead of ${next.username}.`;
  }
  const above = ranked[i - 1];
  const gap = above.convos - me.convos;
  return gap === 0
    ? `Level with ${above.username} in ${ordinal(above.rank)}, who got there first. One more puts you ahead.`
    : `${convos(gap)} behind ${above.username} in ${ordinal(above.rank)}.`;
}
