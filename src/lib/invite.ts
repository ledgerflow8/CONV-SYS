// Bot side of onboarding (PLAN.md §5): redeem a /start token and build the welcome message.
// Kept free of grammY so it can be tested without Telegram.
import { db } from "@/lib/db";
import { isUniqueViolation } from "@/lib/action-result";
import { audit } from "@/lib/audit";
import { decrypt, hashToken } from "@/lib/crypto";
import { appUrl, trackingUrl } from "@/lib/links";

export const EXPIRED_MESSAGE = "This link has expired. Ask your Lead VA for a new one.";
export const NO_TOKEN_MESSAGE = "Hi! Open the invite link your Lead VA sent you to get your login.";
export const ALREADY_LINKED_MESSAGE =
  "This Telegram account is already linked to another login. Ask your Lead VA for help.";

export type Welcome = {
  username: string;
  password: string;
  model: string;
  account: { username: string; phone: string; link: string } | null;
  trackingUrl: string | null;
  loginUrl: string;
};

export function welcomeMessage(w: Welcome): string {
  const lines = [
    "✅ You've been authorised!",
    "",
    `👤 Username: ${w.username}`,
    `🔑 Password: ${w.password}`,
    `📱 Assigned model: ${w.model}`,
  ];
  if (w.account) {
    lines.push(`   TG username: @${w.account.username}`, `   Phone: ${w.account.phone}`, `   Link: ${w.account.link}`);
  } else {
    lines.push("   No Telegram account assigned yet. Your Lead VA will sort this out.");
  }
  if (w.trackingUrl) lines.push(`🔗 Your tracking link: ${w.trackingUrl}`);
  lines.push("", `Log in at: ${w.loginUrl}`, "⚠️ Don't share your login with anyone, not even your Lead VA.");
  return lines.join("\n");
}

type RedeemResult = { ok: true; message: string } | { ok: false; message: string };

/**
 * Validates the token (unused, unexpired), binds the Telegram user, marks the token used and
 * wipes the stored password — all in one transaction. A token can only ever be redeemed once.
 */
export async function redeemInvite(token: string, telegramUserId: bigint): Promise<RedeemResult> {
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(token)) return { ok: false, message: EXPIRED_MESSAGE };
  const tokenHash = hashToken(token);

  try {
    return await db.$transaction(async (tx) => {
      const invite = await tx.inviteToken.findUnique({
        where: { tokenHash },
        select: { id: true, userId: true, usedAt: true, expiresAt: true, passwordEnc: true },
      });
      if (!invite || invite.usedAt || invite.expiresAt <= new Date() || !invite.passwordEnc) {
        return { ok: false, message: EXPIRED_MESSAGE };
      }

      // Claim the token atomically; a concurrent /start with the same token gets count 0.
      const claimed = await tx.inviteToken.updateMany({
        where: { id: invite.id, usedAt: null },
        data: { usedAt: new Date(), passwordEnc: null },
      });
      if (claimed.count === 0) return { ok: false, message: EXPIRED_MESSAGE };

      const user = await tx.user.findFirst({
        where: { id: invite.userId, role: "VA", status: "ACTIVE" },
        select: {
          id: true,
          username: true,
          telegramUserId: true,
          model: { select: { name: true } },
          tgAccount: { select: { username: true, phone: true, link: true } },
          trackingLink: { select: { slug: true, active: true } },
        },
      });
      if (!user) return { ok: false, message: EXPIRED_MESSAGE };
      if (user.telegramUserId !== null && user.telegramUserId !== telegramUserId) {
        // Login already bound to a different Telegram user: don't hand the password to someone else.
        throw new AlreadyLinked();
      }

      await tx.user.update({ where: { id: user.id }, data: { telegramUserId } });
      await audit(tx, { actorId: user.id, action: "va.invite_redeemed", target: user.id });

      return {
        ok: true,
        message: welcomeMessage({
          username: user.username,
          password: decrypt(invite.passwordEnc),
          model: user.model?.name ?? "—",
          account: user.tgAccount,
          trackingUrl: user.trackingLink?.active ? trackingUrl(user.trackingLink.slug) : null,
          loginUrl: `${appUrl()}/login`,
        }),
      };
    });
  } catch (e) {
    // Rolled back, so the token stays unused for the right person.
    // P2002: this Telegram user is already bound to a different login.
    if (e instanceof AlreadyLinked || isUniqueViolation(e)) return { ok: false, message: ALREADY_LINKED_MESSAGE };
    throw e;
  }
}

class AlreadyLinked extends Error {}
