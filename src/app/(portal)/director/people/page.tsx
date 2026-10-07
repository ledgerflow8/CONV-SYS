import { ComingSoon } from "@/components/shell/coming-soon";
import { TopBar } from "@/components/shell/top-bar";

export default function PeoplePage() {
  return (
    <>
      <TopBar title="People" emoji="👥" />
      <ComingSoon block={3} />
    </>
  );
}
