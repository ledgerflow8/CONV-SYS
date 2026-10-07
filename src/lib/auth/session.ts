import { cache } from "react";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import type { Role } from "@prisma/client";
import { db } from "@/lib/db";
import { ROLE_HOME } from "./roles";
import { SESSION_COOKIE, SESSION_TTL_SEC, signSession, verifySession } from "./token";

/**
 * The signed-in user, re-checked against the DB on every request so a fired or
 * disabled user, or one whose password was regenerated, loses access immediately
 * even with a valid cookie.
 */
export const getCurrentUser = cache(async () => {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token) return null;
  const claims = await verifySession(token);
  if (!claims) return null;

  const user = await db.user.findUnique({
    where: { id: claims.sub },
    select: {
      id: true,
      username: true,
      role: true,
      status: true,
      parentId: true,
      modelId: true,
      walletAddress: true,
      sessionVersion: true,
    },
  });
  if (!user || user.status !== "ACTIVE" || user.role !== claims.role) return null;
  if (user.sessionVersion !== claims.sv) return null;
  return user;
});

export type CurrentUser = NonNullable<Awaited<ReturnType<typeof getCurrentUser>>>;

export async function requireUser(): Promise<CurrentUser> {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  return user;
}

export async function requireRole(...roles: Role[]): Promise<CurrentUser> {
  const user = await requireUser();
  if (!roles.includes(user.role)) redirect(ROLE_HOME[user.role]);
  return user;
}

export async function startSession(user: { id: string; role: Role; sessionVersion: number }) {
  const token = await signSession({ sub: user.id, role: user.role, sv: user.sessionVersion });
  (await cookies()).set(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_TTL_SEC,
  });
}

export async function endSession() {
  (await cookies()).delete(SESSION_COOKIE);
}
