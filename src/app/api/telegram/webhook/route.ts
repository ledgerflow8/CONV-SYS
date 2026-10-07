import { timingSafeEqual } from "node:crypto";
import { webhookCallback } from "grammy";
import { getBot } from "@/lib/bot";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

let handler: ((req: Request) => Promise<Response>) | null = null;

function secretMatches(header: string | null, secret: string): boolean {
  if (!header) return false;
  const a = Buffer.from(header);
  const b = Buffer.from(secret);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function POST(req: Request) {
  const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
  const bot = getBot();
  if (!secret || !bot) return new Response("Bot not configured", { status: 503 });

  // Telegram sends the secret we registered with setWebhook; anything else is not Telegram.
  if (!secretMatches(req.headers.get("x-telegram-bot-api-secret-token"), secret)) {
    return new Response("Unauthorized", { status: 401 });
  }

  handler ??= webhookCallback(bot, "std/http");
  return handler(req);
}
