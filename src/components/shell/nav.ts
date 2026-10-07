import type { RoleName } from "@/lib/auth/roles";

export type NavItem = { href: string; label: string; emoji: string };

export const NAV: Record<RoleName, NavItem[]> = {
  DIRECTOR: [
    { href: "/director", label: "Overview", emoji: "📊" },
    { href: "/director/people", label: "People", emoji: "👥" },
    { href: "/director/models", label: "Models", emoji: "⭐" },
    { href: "/director/pool", label: "Telegram Pool", emoji: "📱" },
    { href: "/director/convos", label: "Convos", emoji: "💬" },
    { href: "/director/payouts", label: "Payouts", emoji: "💸" },
    { href: "/director/resources", label: "Resources", emoji: "📚" },
    { href: "/director/settings", label: "Settings", emoji: "⚙️" },
  ],
  LEAD_MANAGER: [
    { href: "/lead-manager", label: "Dashboard", emoji: "📊" },
    { href: "/lead-manager/payouts", label: "Payouts", emoji: "💸" },
  ],
  LEAD_VA: [
    { href: "/lead-va", label: "Dashboard", emoji: "📊" },
    { href: "/lead-va/payouts", label: "Payouts", emoji: "💸" },
  ],
  VA: [
    { href: "/va", label: "My Accounts", emoji: "📱" },
    { href: "/va/resources", label: "Resources", emoji: "📚" },
  ],
};
