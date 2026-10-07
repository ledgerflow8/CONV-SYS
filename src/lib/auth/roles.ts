// Edge-safe (used by middleware): no Prisma imports here.
export const ROLES = ["DIRECTOR", "LEAD_MANAGER", "LEAD_VA", "VA"] as const;
export type RoleName = (typeof ROLES)[number];

export const ROLE_HOME: Record<RoleName, string> = {
  DIRECTOR: "/director",
  LEAD_MANAGER: "/lead-manager",
  LEAD_VA: "/lead-va",
  VA: "/va",
};

export const ROLE_LABEL: Record<RoleName, string> = {
  DIRECTOR: "Director",
  LEAD_MANAGER: "Lead Manager",
  LEAD_VA: "Lead VA",
  VA: "VA",
};

export function isRole(value: unknown): value is RoleName {
  return typeof value === "string" && (ROLES as readonly string[]).includes(value);
}

/** The role that owns a path, or null if the path isn't role-gated. */
export function roleForPath(pathname: string): RoleName | null {
  for (const role of ROLES) {
    const home = ROLE_HOME[role];
    if (pathname === home || pathname.startsWith(`${home}/`)) return role;
  }
  return null;
}
