import type { Role } from "@prisma/client";
import { normalizeHandle } from "@/lib/telegram";

// Portal usernames are the person's Telegram handle plus a role suffix (PLAN.md §7: "@name_LVA").
const SUFFIX: Partial<Record<Role, string>> = { LEAD_MANAGER: "_LM", LEAD_VA: "_LVA" };

export function portalUsername(handle: string, role: Role): string | null {
  const h = normalizeHandle(handle);
  const suffix = SUFFIX[role];
  if (!h || !suffix) return null;
  return `${h}${suffix}`;
}
