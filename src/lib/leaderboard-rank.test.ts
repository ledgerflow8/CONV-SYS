import { describe, expect, it } from "vitest";
import { boardRows, ordinal, rankBoard, standingLine, type BoardEntry } from "./leaderboard-rank";

const at = (min: number) => new Date(Date.UTC(2026, 9, 19, 10, min));
const e = (username: string, convos: number, reachedMin: number | null = null): BoardEntry => ({
  userId: `id_${username}`,
  username,
  convos,
  cents: convos * 25,
  reachedAt: reachedMin === null ? null : at(reachedMin),
});
const PRIZES = [1000, 800, 500];

describe("rankBoard", () => {
  it("ranks by convos, highest first, with distinct ranks", () => {
    const r = rankBoard([e("cara", 3, 1), e("abe", 9, 5), e("ben", 5, 2)], PRIZES);
    expect(r.map((x) => [x.rank, x.username])).toEqual([
      [1, "abe"],
      [2, "ben"],
      [3, "cara"],
    ]);
  });

  it("ties: whoever reached the count first ranks higher", () => {
    const r = rankBoard([e("late", 4, 30), e("early", 4, 10), e("mid", 4, 20)], PRIZES);
    expect(r.map((x) => x.username)).toEqual(["early", "mid", "late"]);
    expect(r.map((x) => x.prizeCents)).toEqual([1000, 800, 500]);
  });

  it("prizes go to the top 3 only, and never to someone with no convos", () => {
    const r = rankBoard([e("a", 2, 1), e("b", 1, 2), e("c", 0), e("d", 0), e("e", 7, 3)], PRIZES);
    expect(r.map((x) => [x.username, x.prizeCents])).toEqual([
      ["e", 1000],
      ["a", 800],
      ["b", 500],
      ["c", 0],
      ["d", 0],
    ]);
    expect(rankBoard([e("x", 0), e("y", 0)], PRIZES).every((x) => x.prizeCents === 0)).toBe(true);
  });

  it("a $0 prize setting means no prize for that place", () => {
    expect(rankBoard([e("a", 3, 1), e("b", 2, 1), e("c", 1, 1)], [3000, 1000, 0]).map((x) => x.prizeCents)).toEqual([3000, 1000, 0]);
  });
});

describe("viewer row", () => {
  const ranked = rankBoard(
    Array.from({ length: 14 }, (_, i) => e(`va${String(i + 1).padStart(2, "0")}`, 20 - i, i)),
    PRIZES,
  );

  it("top 10, plus the viewer's own row when they're below it", () => {
    const me = ranked[12];
    const { top, extra } = boardRows(ranked, new Set([me.userId]));
    expect(top).toHaveLength(10);
    expect(extra.map((x) => [x.rank, x.username])).toEqual([[13, "va13"]]);
    expect(boardRows(ranked, new Set([ranked[3].userId])).extra).toEqual([]); // already in the top 10
  });

  it("shows the gap to the place above", () => {
    expect(standingLine(ranked, ranked[12].userId)).toBe("1 conversation behind va12 in 12th.");
    const spread = rankBoard([e("anna", 12, 1), e("bo", 9, 2)], PRIZES);
    expect(standingLine(spread, "id_bo")).toBe("3 conversations behind anna in 1st.");
    expect(standingLine(spread, "id_anna")).toBe("You're in 1st place, 3 conversations ahead of bo.");
  });

  it("explains a tie lost on time, and a tie won on time", () => {
    const tied = rankBoard([e("second", 5, 9), e("first", 5, 2)], PRIZES);
    expect(standingLine(tied, "id_second")).toBe("Level with first in 1st, who got there first. One more puts you ahead.");
    expect(standingLine(tied, "id_first")).toBe("You're in 1st place, level with second but you got there first.");
  });

  it("with no convos: gap to the last person who has scored", () => {
    const r = rankBoard([e("a", 4, 1), e("b", 2, 2), e("c", 0), e("d", 0)], PRIZES);
    expect(standingLine(r, "id_d")).toBe("2 conversations behind b in 2nd.");
    expect(standingLine(rankBoard([e("a", 0), e("b", 0)], PRIZES), "id_b")).toBe("No conversations yet this week.");
    expect(standingLine(r, "nobody")).toBeNull();
  });

  it("ordinals", () => {
    expect([1, 2, 3, 4, 11, 12, 13, 21, 22, 101, 111].map(ordinal)).toEqual([
      "1st", "2nd", "3rd", "4th", "11th", "12th", "13th", "21st", "22nd", "101st", "111th",
    ]);
  });
});
