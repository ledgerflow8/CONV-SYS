import { NavDrawer } from "@/components/shell/nav-drawer";
import { NAV } from "@/components/shell/nav";
import { ROLE_LABEL } from "@/lib/auth/roles";
import { requireUser } from "@/lib/auth/session";
import { getSetting } from "@/lib/settings";
import { telegramChatUrl } from "@/lib/telegram";

export default async function PortalLayout({ children }: { children: React.ReactNode }) {
  const [user, supportTelegram] = await Promise.all([requireUser(), getSetting("supportTelegram")]);

  return (
    <div className="min-h-dvh bg-muted/40">
      <main className="mx-auto w-full max-w-2xl px-4 pt-6 pb-28">{children}</main>
      <NavDrawer
        items={NAV[user.role]}
        username={user.username}
        roleLabel={ROLE_LABEL[user.role]}
        supportUrl={telegramChatUrl(supportTelegram)}
      />
    </div>
  );
}
