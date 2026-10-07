import { requireRole } from "@/lib/auth/session";

export default async function RoleLayout({ children }: { children: React.ReactNode }) {
  await requireRole("VA");
  return children;
}
