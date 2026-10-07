// Registers the bot webhook with Telegram: npm run bot:webhook
// Needs TELEGRAM_BOT_TOKEN, TELEGRAM_WEBHOOK_SECRET and a public https APP_URL (read from .env).

async function main() {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
  const app = process.env.APP_URL?.replace(/\/+$/, "");
  if (!token || !secret || !app) throw new Error("Set TELEGRAM_BOT_TOKEN, TELEGRAM_WEBHOOK_SECRET and APP_URL first.");
  if (!app.startsWith("https://")) throw new Error("Telegram only delivers webhooks to https URLs.");

  const res = await fetch(`https://api.telegram.org/bot${token}/setWebhook`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      url: `${app}/api/telegram/webhook`,
      secret_token: secret,
      allowed_updates: ["message"],
      drop_pending_updates: true,
    }),
  });
  const body = (await res.json()) as { ok: boolean; description?: string };
  console.log(body.ok ? `Webhook set to ${app}/api/telegram/webhook` : `Failed: ${body.description}`);
  if (!body.ok) process.exit(1);
}

main();
