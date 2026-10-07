import { ComingSoon } from "@/components/shell/coming-soon";
import { TopBar } from "@/components/shell/top-bar";

export default function PayoutsPage() {
  return (
    <>
      <TopBar title="Payouts" emoji="💸" />
      <ComingSoon block={8} />
    </>
  );
}
