import { ComingSoon } from "@/components/shell/coming-soon";
import { TopBar } from "@/components/shell/top-bar";

export default function DashboardPage() {
  return (
    <>
      <TopBar title="Dashboard" emoji="📊" />
      <ComingSoon block={3} />
    </>
  );
}
