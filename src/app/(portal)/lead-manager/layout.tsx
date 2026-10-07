import { requireRole } from "@/lib/auth/session";

export default async function RoleLayout({ children }: { children: React.ReactNode }) {
  await requireRole("LEAD_MANAGER");
  return children;
}
