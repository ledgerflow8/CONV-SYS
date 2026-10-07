import { ComingSoon } from "@/components/shell/coming-soon";
import { TopBar } from "@/components/shell/top-bar";

export default function ModelsPage() {
  return (
    <>
      <TopBar title="Models" emoji="⭐" />
      <ComingSoon block={3} />
    </>
  );
}
