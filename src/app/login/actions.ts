"use server";

import bcrypt from "bcryptjs";
import { redirect } from "next/navigation";
import { z } from "zod";
import { db } from "@/lib/db";
import { cleanPassword, cleanUsername, suffixCandidates } from "@/lib/auth/credentials";
import { ROLE_HOME } from "@/lib/auth/roles";
import { startSession } from "@/lib/auth/session";

// Cleaned before validation: credentials arrive by copy-paste through Telegram (see credentials.ts).
const schema = z.object({
  username: z.string().transform(cleanUsername).pipe(z.string().min(1).max(64)),
  password: z.string().transform(cleanPassword).pipe(z.string().min(1).max(200)),
});

export type LoginState = { error: string } | undefined;

// Compared against when the username doesn't exist, so response time doesn't reveal it.
const DUMMY_HASH = bcrypt.hashSync("not-a-real-password", 10);

const select = { id: true, role: true, status: true, passwordHash: true, sessionVersion: true } as const;

async function findUser(username: string) {
  const exact = await db.user.findFirst({ where: { username: { equals: username, mode: "insensitive" } }, select });
  if (exact) return exact;
  // Typed their Telegram handle without _LM / _LVA / _VA: use it only if it points to exactly one login.
  const candidates = suffixCandidates(username);
  if (candidates.length === 0) return null;
  const matches = await db.user.findMany({
    where: { OR: candidates.map((c) => ({ username: { equals: c, mode: "insensitive" as const } })) },
    select,
    take: 2,
  });
  return matches.length === 1 ? matches[0] : null;
}

export async function login(_prev: LoginState, formData: FormData): Promise<LoginState> {
  const parsed = schema.safeParse({
    username: formData.get("username") ?? "",
    password: formData.get("password") ?? "",
  });
  if (!parsed.success) return { error: "Enter your username and password." };

  const user = await findUser(parsed.data.username);
  const ok = await bcrypt.compare(parsed.data.password, user?.passwordHash ?? DUMMY_HASH);
  if (!user || !ok) {
    return { error: "Wrong username or password. Copy both exactly as you received them; usernames end in _LM, _LVA or _VA." };
  }
  if (user.status !== "ACTIVE") return { error: "This account is no longer active." };

  await startSession(user);
  redirect(ROLE_HOME[user.role]);
}
