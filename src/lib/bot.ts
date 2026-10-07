// grammY bot, webhook mode only (PLAN.md §2). Created lazily so builds don't need the token.
import { Bot } from "grammy";
import { NO_TOKEN_MESSAGE, redeemInvite } from "@/lib/invite";

let bot: Bot | null = null;

export function getBot(): Bot | null {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return null;
  if (bot) return bot;

  bot = new Bot(token);

  bot.command("start", async (ctx) => {
    // Invites are personal: only handle them in a private chat with the person themselves.
    if (ctx.chat.type !== "private" || !ctx.from) return;
    const payload = ctx.match.trim();
    if (!payload) return void (await ctx.reply(NO_TOKEN_MESSAGE));

    const result = await redeemInvite(payload, BigInt(ctx.from.id));
    await ctx.reply(result.message, { link_preview_options: { is_disabled: true } });
  });

  bot.catch((err) => {
    console.error("[bot] update failed", err.error instanceof Error ? err.error.message : err.error);
  });

  return bot;
}
