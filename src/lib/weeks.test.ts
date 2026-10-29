import { describe, expect, it } from "vitest";
import { dayBounds, offsetMinutes, parseLocalDateTime, WEEK_MS, weekBounds } from "./weeks";

describe("dayBounds (GMT+2)", () => {
  it("a local day runs 22:00Z → 22:00Z", () => {
    const b = dayBounds(new Date("2026-10-07T23:30:00Z"), "Etc/GMT-2"); // Thu 01:30 local
    expect([b.startsAt.toISOString(), b.endsAt.toISOString()]).toEqual(["2026-10-07T22:00:00.000Z", "2026-10-08T22:00:00.000Z"]);
  });
});

const iso = (d: Date) => d.toISOString();

describe("offsetMinutes", () => {
  it("handles the inverted Etc/GMT sign", () => {
    expect(offsetMinutes("Etc/GMT-2")).toBe(120);
    expect(offsetMinutes("Etc/GMT+5")).toBe(-300);
    expect(offsetMinutes("UTC")).toBe(0);
  });

  it("rejects DST zones", () => {
    expect(() => offsetMinutes("Europe/Berlin")).toThrow();
  });
});

describe("weekBounds (GMT+2)", () => {
  const tz = "Etc/GMT-2";
  // Monday 2026-10-05 00:00 GMT+2 == Sunday 2026-10-04 22:00Z
  const start = "2026-10-04T22:00:00.000Z";
  const end = "2026-10-11T22:00:00.000Z";

  it("Monday 00:00 local starts the week", () => {
    expect(iso(weekBounds(new Date(start), tz).startsAt)).toBe(start);
  });

  it("a moment before Monday 00:00 local is the previous week", () => {
    expect(iso(weekBounds(new Date("2026-10-04T21:59:59.999Z"), tz).startsAt)).toBe("2026-09-27T22:00:00.000Z");
  });

  it("Sunday 23:59:59 local is still this week", () => {
    const b = weekBounds(new Date("2026-10-11T21:59:59.999Z"), tz);
    expect([iso(b.startsAt), iso(b.endsAt)]).toEqual([start, end]);
  });

  it("midweek in UTC terms near midnight still maps by local time", () => {
    // Wed 2026-10-07 23:30Z is Thu 01:30 local — same week
    expect(iso(weekBounds(new Date("2026-10-07T23:30:00Z"), tz).startsAt)).toBe(start);
  });

  it("every week is exactly 7 days and weeks tile with no gaps", () => {
    let at = new Date("2026-01-01T00:00:00Z");
    let prevEnd: Date | null = null;
    for (let i = 0; i < 60; i++) {
      const b = weekBounds(at, tz);
      expect(b.endsAt.getTime() - b.startsAt.getTime()).toBe(WEEK_MS);
      if (prevEnd) expect(iso(b.startsAt)).toBe(iso(prevEnd));
      prevEnd = b.endsAt;
      at = b.endsAt;
    }
  });
});

describe("parseLocalDateTime", () => {
  it("reads a datetime-local value as org-timezone wall time", () => {
    // GMT+2: 18:00 local on Sun 25 Oct = 16:00 UTC (the panel outage started ~16:00 UTC)
    expect(parseLocalDateTime("2026-10-25T18:00", "Etc/GMT-2")?.toISOString()).toBe("2026-10-25T16:00:00.000Z");
    expect(parseLocalDateTime("2026-10-25T22:40", "Etc/GMT-2")?.toISOString()).toBe("2026-10-25T20:40:00.000Z");
    expect(parseLocalDateTime("2026-10-25T16:00", "UTC")?.toISOString()).toBe("2026-10-25T16:00:00.000Z");
    for (const bad of ["", "2026-10-25", "2026-13-01T00:00", "2026-11-31T10:00", "2026-10-25T24:00", undefined, null]) {
      expect(parseLocalDateTime(bad, "Etc/GMT-2")).toBeNull();
    }
  });
});
