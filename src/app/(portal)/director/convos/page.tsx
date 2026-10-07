import { ComingSoon } from "@/components/shell/coming-soon";
import { TopBar } from "@/components/shell/top-bar";

export default function ConvosPage() {
  return (
    <>
      <TopBar title="Convos" emoji="💬" />
      <ComingSoon block={6} />
    </>
  );
}
