// Find the TgAccount an ingest event belongs to. The numeric Telegram id is the stable key: it
// survives username changes, so a convo or status report always lands on the right account even
// right after a rename. We fall back to the username (or internal id), and backfill the numeric id
// the first time we learn it, so later events match on it directly.
import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";

type DbClient = Prisma.TransactionClient | typeof db;

const SELECT = { id: true, username: true, modelId: true, tgUserId: true, lastSeenAt: true } as const;

export type MatchedAccount = {
  id: string;
  username: string | null;
  modelId: string | null;
  tgUserId: bigint | null;
  lastSeenAt: Date | null;
};

export function parseTgUserId(v: unknown): bigint | null {
  if (typeof v !== "string" || !/^\d{1,19}$/.test(v)) return null;
  try {
    return BigInt(v);
  } catch {
    return null;
  }
}

export async function matchTgAccount(
  client: DbClient,
  opts: { tgUserId?: string | null; tgAccount?: string | null },
): Promise<MatchedAccount | null> {
  const tgUserId = parseTgUserId(opts.tgUserId);

  // 1) By stable numeric id first (survives renames).
  if (tgUserId !== null) {
    const byId = await client.tgAccount.findFirst({ where: { tgUserId }, select: SELECT });
    if (byId) return byId;
  }

  // 2) Fall back to username, or the internal id.
  const input = (opts.tgAccount ?? "").replace(/^@/, "");
  if (!input) return null;
  const byName = await client.tgAccount.findFirst({
    where: { OR: [{ username: input.toLowerCase() }, { id: input }] },
    select: SELECT,
  });
  if (!byName) return null;

  // 3) Backfill the numeric id once, so future events match on it directly.
  if (tgUserId !== null && byName.tgUserId === null) {
    await client.tgAccount.update({ where: { id: byName.id }, data: { tgUserId } });
    return { ...byName, tgUserId };
  }
  return byName;
}
