// Telegram usernames: 5–32 chars, letters, digits, underscores; must start with a letter.
const HANDLE = /^[A-Za-z][A-Za-z0-9_]{4,31}$/;

/** "@Some_Handle" → "Some_Handle", or null if it isn't a valid Telegram username. */
export function normalizeHandle(input: string): string | null {
  const handle = input.trim().replace(/^@/, "");
  return HANDLE.test(handle) ? handle : null;
}

export function telegramChatUrl(handle: string): string | null {
  const h = normalizeHandle(handle);
  return h ? `https://t.me/${h}` : null;
}
