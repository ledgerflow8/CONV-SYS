"use server";

import bcrypt from "bcryptjs";
import { redirect } from "next/navigation";
import { z } from "zod";
import { db } from "@/lib/db";
import { ROLE_HOME } from "@/lib/auth/roles";
import { startSession } from "@/lib/auth/session";

const schema = z.object({
  username: z.string().trim().min(1).max(64),
  password: z.string().min(1).max(200),
});

export type LoginState = { error: string } | undefined;

// Compared against when the username doesn't exist, so response time doesn't reveal it.
const DUMMY_HASH = bcrypt.hashSync("not-a-real-password", 10);

export async function login(_prev: LoginState, formData: FormData): Promise<LoginState> {
  const parsed = schema.safeParse({
    username: formData.get("username"),
    password: formData.get("password"),
  });
  if (!parsed.success) return { error: "Enter your username and password." };

  const user = await db.user.findFirst({
    where: { username: { equals: parsed.data.username, mode: "insensitive" } },
    select: { id: true, role: true, status: true, passwordHash: true, sessionVersion: true },
  });
  const ok = await bcrypt.compare(parsed.data.password, user?.passwordHash ?? DUMMY_HASH);
  if (!user || !ok) return { error: "Wrong username or password." };
  if (user.status !== "ACTIVE") return { error: "This account is no longer active." };

  await startSession(user);
  redirect(ROLE_HOME[user.role]);
}
