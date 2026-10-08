import { CommissionPage } from "@/components/commission-page";
import { requireRole } from "@/lib/auth/session";

export default async function LeadVaPayoutsPage() {
  const user = await requireRole("LEAD_VA");
  return <CommissionPage user={{ ...user, role: "LEAD_VA" }} />;
}
