// Public URLs built from env. Kept in one place so the bot and pages agree.

export function appUrl(): string {
  return (process.env.APP_URL ?? "http://localhost:3000").replace(/\/+$/, "");
}

export function trackingUrl(slug: string): string {
  return `${appUrl()}/v/${slug}`;
}

/** null until TELEGRAM_BOT_USERNAME is set. */
export function botInviteUrl(token: string): string | null {
  const bot = process.env.TELEGRAM_BOT_USERNAME?.trim().replace(/^@/, "");
  return bot ? `https://t.me/${bot}?start=${token}` : null;
}
