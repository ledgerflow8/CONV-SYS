// Registers the bot webhook with Telegram: npm run bot:webhook
// Needs TELEGRAM_BOT_TOKEN, TELEGRAM_WEBHOOK_SECRET and a public https APP_URL (read from .env;
// a value on the command line wins, e.g. APP_URL=https://www.fansflow.site npm run bot:webhook).
// --info only shows what Telegram has registered now (changes nothing): npm run bot:webhook -- --info
// Updates Telegram is still holding (it keeps undelivered ones ~24 h, e.g. /start presses while the old
// address was down) are delivered to the new address. --drop-pending discards them instead.

type WebhookInfo = { url: string; pending_update_count: number; last_error_date?: number; last_error_message?: string };

async function telegram<T>(token: string, method: string, body?: object): Promise<T> {
  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  const json = (await res.json()) as { ok: boolean; result: T; description?: string };
  if (!json.ok) throw new Error(`${method} failed: ${json.description}`);
  return json.result;
}

function show(info: WebhookInfo) {
  console.log(`Telegram delivers to: ${info.url || "(no webhook set)"}`);
  console.log(`Pending updates: ${info.pending_update_count}`);
  if (info.last_error_message) {
    console.log(`Last delivery error: ${info.last_error_message} (${new Date((info.last_error_date ?? 0) * 1000).toISOString()})`);
  }
}

async function main() {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error("Set TELEGRAM_BOT_TOKEN first.");
  if (process.argv.includes("--info")) {
    show(await telegram<WebhookInfo>(token, "getWebhookInfo"));
    return;
  }

  const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
  const app = process.env.APP_URL?.replace(/\/+$/, "");
  if (!secret || !app) throw new Error("Set TELEGRAM_WEBHOOK_SECRET and APP_URL first.");
  if (!app.startsWith("https://")) throw new Error("Telegram only delivers webhooks to https URLs.");

  // Telegram doesn't follow redirects: a webhook on an address that redirects (an old domain, or the bare
  // domain when the site lives on www) silently drops every /start. Refuse it up front.
  const probe = await fetch(`${app}/api/health`, { redirect: "manual" });
  if (probe.status >= 300 && probe.status < 400) {
    throw new Error(`${app} redirects (${probe.status}) to ${probe.headers.get("location")}. Use that address as APP_URL.`);
  }
  if (!probe.ok) throw new Error(`${app}/api/health answered ${probe.status}; is the site deployed there?`);

  await telegram(token, "setWebhook", {
    url: `${app}/api/telegram/webhook`,
    secret_token: secret,
    allowed_updates: ["message"],
    drop_pending_updates: process.argv.includes("--drop-pending"),
  });
  console.log(`Webhook set to ${app}/api/telegram/webhook`);
  show(await telegram<WebhookInfo>(token, "getWebhookInfo"));
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
