// Bot DMs to users (PLAN.md §5: ban/reassign notices). Best-effort: a failed or impossible
// notification never undoes the change that triggered it; the outcome is returned for the UI.
import { getBot } from "@/lib/bot";
import { db } from "@/lib/db";
import { trackingUrl } from "@/lib/links";

export type NotifyResult = "sent" | "not_linked" | "bot_not_configured" | "failed";

export interface Notifier {
  send(telegramUserId: bigint, text: string): Promise<void>;
}

const botNotifier: Notifier = {
  async send(chatId, text) {
    const bot = getBot();
    if (!bot) throw new BotNotConfigured();
    await bot.api.sendMessage(chatId.toString(), text, { link_preview_options: { is_disabled: true } });
  },
};
class BotNotConfigured extends Error {}

let impl: Notifier = botNotifier;
/** Tests only. */
export function setNotifierForTests(n: Notifier | null) {
  impl = n ?? botNotifier;
}

export async function notifyUser(userId: string, text: string): Promise<NotifyResult> {
  const user = await db.user.findUnique({ where: { id: userId }, select: { telegramUserId: true } });
  if (!user?.telegramUserId) return "not_linked";
  try {
    await impl.send(user.telegramUserId, text);
    return "sent";
  } catch (e) {
    if (e instanceof BotNotConfigured) return "bot_not_configured";
    console.error("[notify] send failed", e instanceof Error ? e.message : e);
    return "failed";
  }
}

/** Tells a VA their Telegram account changed (or that none is free yet). */
export async function notifyAccountChange(vaId: string, reason: "banned" | "retired" | "assigned"): Promise<NotifyResult> {
  const va = await db.user.findUnique({
    where: { id: vaId },
    select: { tgAccount: { select: { username: true, phone: true, link: true } }, trackingLink: { select: { slug: true, active: true } } },
  });
  if (!va) return "failed";
  const why = reason === "assigned" ? "You've been assigned a Telegram account." : "Your Telegram account was taken out of service.";
  const lines = va.tgAccount
    ? [
        `🔄 ${why}`,
        "",
        `📱 New account: @${va.tgAccount.username}`,
        `   Phone: ${va.tgAccount.phone}`,
        `   Link: ${va.tgAccount.link}`,
        ...(va.trackingLink?.active ? [`🔗 Your tracking link still works and now points to it: ${trackingUrl(va.trackingLink.slug)}`] : []),
      ]
    : [`⚠️ ${why}`, "", "No replacement is free right now. Your Lead VA will assign one as soon as possible."];
  return notifyUser(vaId, lines.join("\n"));
}
