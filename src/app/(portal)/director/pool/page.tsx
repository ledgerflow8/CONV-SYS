import { ComingSoon } from "@/components/shell/coming-soon";
import { TopBar } from "@/components/shell/top-bar";

export default function TelegramPoolPage() {
  return (
    <>
      <TopBar title="Telegram Pool" emoji="📱" />
      <ComingSoon block={3} />
    </>
  );
}
