import { ComingSoon } from "@/components/shell/coming-soon";
import { TopBar } from "@/components/shell/top-bar";

export default function MyAccountsPage() {
  return (
    <>
      <TopBar title="My Accounts" emoji="📱" />
      <ComingSoon block={7} />
    </>
  );
}
