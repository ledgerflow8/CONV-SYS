import { ComingSoon } from "@/components/shell/coming-soon";
import { TopBar } from "@/components/shell/top-bar";

export default function ResourcesPage() {
  return (
    <>
      <TopBar title="Resources" emoji="📚" />
      <ComingSoon block={9} />
    </>
  );
}
