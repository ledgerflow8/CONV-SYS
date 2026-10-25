// Weekly leaderboard ranking (pure; safe to import on the client). Loading lives in leaderboard.ts.
export type Board = "VA" | "LEAD_VA";

export type BoardEntry = {
  userId: string;
  username: string;
  convos: number; // qualified convos this week: the same count earnings are paid on
  cents: number; // what those convos earned them (snapshotted rates)
  reachedAt: Date | null; // when they reached `convos` (their latest qualified convo)
};

export type Ranked = BoardEntry & {
  rank: number;
  prizePlace: number | null; // 1..3: the prize this person is in line for (or won), if they meet its minimum
  prizeCents: number;
};

/** One board's prize rules, per place (index 0 = 1st). */
export type PrizeRules = {
  prizes: readonly number[]; // cents
  minConvos: readonly number[]; // qualified convos needed for that place
  passDown: boolean; // false: an unmet place isn't paid; true: it goes to the next person who meets it
};

export const PRIZE_PLACES = 3;
export const MEDAL = ["🥇", "🥈", "🥉"] as const;

/** Convos needed for a place: its minimum, and never less than one. */
export const needFor = (rules: PrizeRules, place: number) => Math.max(1, rules.minConvos[place - 1] ?? 0);

/**
 * Most convos first. Ties: whoever reached the count first ranks higher. Ranks are always distinct.
 * Prizes: place N goes to rank N if they meet place N's minimum, otherwise to nobody, or, with
 * passDown, to the best-ranked person not already holding a prize who meets it.
 */
export function rankBoard(entries: BoardEntry[], rules: PrizeRules): Ranked[] {
  const time = (d: Date | null) => d?.getTime() ?? Number.POSITIVE_INFINITY;
  const ranked: Ranked[] = [...entries]
    .sort((a, b) => b.convos - a.convos || time(a.reachedAt) - time(b.reachedAt) || a.username.localeCompare(b.username))
    .map((e, i) => ({ ...e, rank: i + 1, prizePlace: null, prizeCents: 0 }));

  for (let place = 1; place <= PRIZE_PLACES; place++) {
    const need = needFor(rules, place);
    const winner = rules.passDown
      ? ranked.find((r) => r.prizePlace === null && r.convos >= need)
      : ranked[place - 1]?.convos >= need
        ? ranked[place - 1]
        : undefined;
    if (winner) {
      winner.prizePlace = place;
      winner.prizeCents = rules.prizes[place - 1] ?? 0;
    }
  }
  return ranked;
}

/**
 * The viewer's progress toward a prize: "157 more convos to qualify for a prize." while they're
 * below every place's minimum, then "… to qualify for 1st place." while below a higher place's.
 */
export function progressLine(ranked: Ranked[], userId: string, rules: PrizeRules): string | null {
  const me = ranked.find((r) => r.userId === userId);
  if (!me) return null;
  const places = [1, 2, 3].filter((p) => (rules.prizes[p - 1] ?? 0) > 0);
  if (places.length === 0) return null;
  const more = (n: number) => `${n} more convo${n === 1 ? "" : "s"}`;
  const lowest = Math.min(...places.map((p) => needFor(rules, p)));
  if (me.convos < lowest) return `${more(lowest - me.convos)} to qualify for a prize.`;
  const higher = places.find((p) => needFor(rules, p) > me.convos);
  return higher ? `${more(needFor(rules, higher) - me.convos)} to qualify for ${ordinal(higher)} place.` : null;
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
