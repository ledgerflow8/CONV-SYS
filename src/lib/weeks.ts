// Pay weeks (PLAN.md §1): Monday 00:00 → Sunday 23:59:59.999 in the org timezone.
// Only fixed-offset zones (Etc/GMT±N, UTC) are allowed, so every week is exactly 7×24h.
import type { Prisma } from "@prisma/client";

const DAY_MS = 24 * 60 * 60 * 1000;
export const WEEK_MS = 7 * DAY_MS;

/** Minutes east of UTC. IANA "Etc/GMT-2" is UTC+2 (the sign is inverted). */
export function offsetMinutes(timeZone: string): number {
  if (timeZone === "UTC" || timeZone === "Etc/UTC" || timeZone === "Etc/GMT") return 0;
  const m = timeZone.match(/^Etc\/GMT([+-])(\d{1,2})$/);
  if (!m) throw new Error(`Unsupported timezone "${timeZone}": use a fixed-offset Etc/GMT±N zone`);
  return (m[1] === "-" ? 1 : -1) * Number(m[2]) * 60;
}

/** The [start, end) UTC instants of the pay week containing `at`. */
export function weekBounds(at: Date, timeZone: string): { startsAt: Date; endsAt: Date } {
  const offsetMs = offsetMinutes(timeZone) * 60 * 1000;
  const local = new Date(at.getTime() + offsetMs); // wall-clock time, read with getUTC*
  const daysSinceMonday = (local.getUTCDay() + 6) % 7;
  const localMidnight = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate());
  const startsAt = new Date(localMidnight - daysSinceMonday * DAY_MS - offsetMs);
  return { startsAt, endsAt: new Date(startsAt.getTime() + WEEK_MS) };
}

/** Finds or creates the Week row for `at`. Safe under concurrency (unique on startsAt). */
export async function weekFor(tx: Prisma.TransactionClient, at: Date, timeZone: string) {
  const { startsAt, endsAt } = weekBounds(at, timeZone);
  return tx.week.upsert({ where: { startsAt }, update: {}, create: { startsAt, endsAt } });
}
