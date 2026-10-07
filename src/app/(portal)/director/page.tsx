import { ComingSoon } from "@/components/shell/coming-soon";
import { TopBar } from "@/components/shell/top-bar";

export default function OverviewPage() {
  return (
    <>
      <TopBar title="Overview" emoji="📊" />
      <ComingSoon block={7} />
    </>
  );
}
