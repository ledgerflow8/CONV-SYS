// Signed session token. Edge-safe (used by middleware).
import { SignJWT, jwtVerify } from "jose";
import { isRole, type RoleName } from "./roles";

export const SESSION_COOKIE = "session";
export const SESSION_TTL_SEC = 60 * 60 * 24 * 7;

export type SessionClaims = { sub: string; role: RoleName; sv: number };

function key() {
  const secret = process.env.SESSION_SECRET;
  if (!secret || secret.length < 32) throw new Error("SESSION_SECRET is missing or shorter than 32 chars");
  return new TextEncoder().encode(secret);
}

export function signSession({ sub, role, sv }: SessionClaims): Promise<string> {
  return new SignJWT({ role, sv })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(sub)
    .setIssuedAt()
    .setExpirationTime(`${SESSION_TTL_SEC}s`)
    .sign(key());
}

export async function verifySession(token: string): Promise<SessionClaims | null> {
  try {
    const { payload } = await jwtVerify(token, key(), { algorithms: ["HS256"] });
    if (typeof payload.sub !== "string" || !isRole(payload.role) || !Number.isInteger(payload.sv)) return null;
    return { sub: payload.sub, role: payload.role, sv: payload.sv as number };
  } catch {
    return null;
  }
}
