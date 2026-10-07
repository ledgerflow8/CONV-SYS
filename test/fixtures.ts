// Builders for database tests. Every test starts from an empty database.
import type { Prisma, Role } from "@prisma/client";
import { db } from "@/lib/db";
import { SETTING_DEFAULTS, type Settings } from "@/lib/settings-defaults";
import type { CurrentUser } from "@/lib/auth/session";

export async function resetDb() {
  if (!process.env.DATABASE_URL?.match(/\/[^/?]+_test(\?|$)/)) throw new Error("resetDb only runs against a *_test database");
  const tables = await db.$queryRaw<{ tablename: string }[]>`
    SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'`;
  await db.$executeRawUnsafe(`TRUNCATE ${tables.map((t) => `"${t.tablename}"`).join(", ")} CASCADE`);
  await db.setting.createMany({
    data: Object.entries(SETTING_DEFAULTS).map(([key, value]) => ({ key, value: value as Prisma.InputJsonValue })),
  });
}

export async function setSetting<K extends keyof Settings>(key: K, value: Settings[K]) {
  const v = value as Prisma.InputJsonValue;
  await db.setting.upsert({ where: { key }, update: { value: v }, create: { key, value: v } });
}

let n = 0;
const uid = (p: string) => `${p}${++n}${Math.random().toString(36).slice(2, 6)}`;

export function asActor(u: { id: string; role: Role; modelId: string | null }): CurrentUser {
  return { id: u.id, username: "x", role: u.role, status: "ACTIVE", parentId: null, modelId: u.modelId, walletAddress: null, sessionVersion: 0 };
}

export async function makeUser(role: Role, parentId: string | null, modelId: string | null = null) {
  return db.user.create({ data: { username: uid(role.toLowerCase()), passwordHash: "x", role, parentId, modelId } });
}

export async function makeModel() {
  return db.model.create({ data: { name: uid("Model") } });
}

export async function makeAccount(modelId: string) {
  const username = uid("acct");
  return db.tgAccount.create({ data: { modelId, username, phone: "+13095550100", link: `https://t.me/${username}` } });
}

/** Assigns an account to a VA from `startedAt` (default: an hour ago). */
export async function assign(accountId: string, vaId: string, startedAt = new Date(Date.now() - 3600_000)) {
  await db.tgAccount.update({ where: { id: accountId }, data: { status: "ASSIGNED", vaId } });
  return db.tgAssignment.create({ data: { tgAccountId: accountId, vaId, startedAt } });
}

/** Director → LM → Lead VA → VA holding one account, plus the VA's tracking link. */
export async function makeTeam() {
  const model = await makeModel();
  const director = await makeUser("DIRECTOR", null);
  const lm = await makeUser("LEAD_MANAGER", director.id);
  const lva = await makeUser("LEAD_VA", lm.id, model.id);
  const va = await makeUser("VA", lva.id, model.id);
  const account = await makeAccount(model.id);
  await assign(account.id, va.id, new Date(Date.now() - 30 * 24 * 3600_000));
  const link = await db.trackingLink.create({ data: { vaId: va.id, slug: uid("s") } });
  return { model, director, lm, lva, va, account, link };
}

export const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000);
