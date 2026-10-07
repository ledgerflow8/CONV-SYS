export type Fail = { ok: false; error: string };
export type Result<T> = { ok: true; data: T } | Fail;

export const fail = (error: string): Fail => ({ ok: false, error });

/** Postgres unique-constraint violation, e.g. two people creating the same username at once. */
export function isUniqueViolation(e: unknown): boolean {
  return typeof e === "object" && e !== null && "code" in e && (e as { code: unknown }).code === "P2002";
}
