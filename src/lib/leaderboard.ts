// Weekly leaderboards (VA board, Lead VA board) and their prizes.
//
// Deliberately agency-wide: every VA sees every other active VA's name, convo count and earnings,
// so this does not go through scopeFor(user). It only ever returns that projection (no wallets,
// accounts or convo rows), and it counts exactly what payouts count: QUALIFIED convos by the
// snapshotted vaId / leadVaId and their snapshotted cents.
import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { rankBoard, PRIZE_PLACES, type Board, type Ranked } from "@/lib/leaderboard-rank";
import { getSetting } from "@/lib/settings";
import type { Settings } from "@/lib/settings-defaults";
import { inWeek, type Period } from "@/lib/stats";

export const BOARDS: readonly Board[] = ["VA", "LEAD_VA"];
const PRIZE_KEY = { VA: "va", LEAD_VA: "leadVa" } as const;

export const prizesFor = (prizes: Settings["leaderboardPrizes"], board: Board) => prizes[PRIZE_KEY[board]].slice(0, PRIZE_PLACES);

/** Every ACTIVE user of the board's role, ranked on the convos matching `convoWhere` (a week). */
export async function loadBoard(client: Prisma.TransactionClient, board: Board, convoWhere: Prisma.ConvoWhereInput, prizes: readonly number[]): Promise<Ranked[]> {
  const where: Prisma.ConvoWhereInput = { AND: [{ status: "QUALIFIED" }, convoWhere] };
  const users = await client.user.findMany({ where: { role: board, status: "ACTIVE" }, select: { id: true, username: true } });
  const groups =
    board === "VA"
      ? (await client.convo.groupBy({ by: ["vaId"], where, _count: true, _sum: { vaCents: true }, _max: { qualifiedAt: true } })).map((g) => ({
          id: g.vaId,
          convos: g._count,
          cents: g._sum.vaCents ?? 0,
          reachedAt: g._max.qualifiedAt,
        }))
      : (await client.convo.groupBy({ by: ["leadVaId"], where, _count: true, _sum: { leadVaCents: true }, _max: { qualifiedAt: true } })).map((g) => ({
          id: g.leadVaId,
          convos: g._count,
          cents: g._sum.leadVaCents ?? 0,
          reachedAt: g._max.qualifiedAt,
        }));
  const by = new Map(groups.map((g) => [g.id, g]));
  return rankBoard(
    users.map((u) => {
      const g = by.get(u.id);
      return { userId: u.id, username: u.username, convos: g?.convos ?? 0, cents: g?.cents ?? 0, reachedAt: g?.reachedAt ?? null };
    }),
    prizes,
  );
}

/** Live board for the current (open) week. */
export async function liveBoard(board: Board, week: Period): Promise<Ranked[]> {
  const prizes = await getSetting("leaderboardPrizes");
  return loadBoard(db, board, inWeek(week), prizesFor(prizes, board));
}

export type Win = { board: Board; rank: number; userId: string; convos: number; prizeCents: number };

/**
 * Week lock (inside its transaction): freezes each board's top 3 (with at least one convo) as
 * LeaderboardWin rows. The unique (weekId, board, rank) key means a week can only be settled once.
 */
export async function settleBoards(tx: Prisma.TransactionClient, weekId: string, prizes: Settings["leaderboardPrizes"]): Promise<Win[]> {
  const wins: Win[] = [];
  for (const board of BOARDS) {
    const ranked = await loadBoard(tx, board, { weekId }, prizesFor(prizes, board));
    for (const r of ranked.slice(0, PRIZE_PLACES)) {
      if (r.convos > 0) wins.push({ board, rank: r.rank, userId: r.userId, convos: r.convos, prizeCents: r.prizeCents });
    }
  }
  if (wins.length) await tx.leaderboardWin.createMany({ data: wins.map((w) => ({ weekId, ...w })) });
  return wins;
}

/** Director: winners of the most recent locked weeks, newest first. */
export async function pastWinners(limit = 6) {
  const weeks = await db.week.findMany({
    where: { status: { not: "OPEN" }, leaderboardWins: { some: {} } },
    orderBy: { startsAt: "desc" },
    take: limit,
    select: {
      id: true,
      startsAt: true,
      endsAt: true,
      leaderboardWins: {
        orderBy: [{ board: "asc" }, { rank: "asc" }],
        select: { board: true, rank: true, convos: true, prizeCents: true, user: { select: { username: true } } },
      },
    },
  });
  return weeks;
}
