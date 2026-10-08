import { CommissionPage } from "@/components/commission-page";
import { requireRole } from "@/lib/auth/session";

export default async function LeadManagerPayoutsPage() {
  const user = await requireRole("LEAD_MANAGER");
  return <CommissionPage user={{ ...user, role: "LEAD_MANAGER" }} />;
}
