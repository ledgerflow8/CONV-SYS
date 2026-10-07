// Request parsing for tracking-link clicks (PLAN.md §6). Pure functions; no DB.
import { createHmac } from "node:crypto";

type Headers = { get(name: string): string | null };

const ISO2 = /^[A-Z]{2}$/;

/** Country from the host's geo header: Vercel `x-vercel-ip-country`, Netlify `x-nf-geo` (base64 JSON). */
export function countryFromHeaders(h: Headers): string | null {
  const vercel = h.get("x-vercel-ip-country")?.trim().toUpperCase();
  if (vercel && ISO2.test(vercel)) return vercel;

  const nf = h.get("x-nf-geo");
  if (nf) {
    try {
      const geo = JSON.parse(Buffer.from(nf, "base64").toString("utf8")) as { country?: { code?: unknown } };
      const code = typeof geo.country?.code === "string" ? geo.country.code.toUpperCase() : null;
      if (code && ISO2.test(code)) return code;
    } catch {
      // malformed header: treat as unknown
    }
  }
  return null;
}

/** "https://www.Reddit.com/r/x" → "reddit.com". Only http(s) referrers count. */
export function refDomainOf(referrer: string | null): string | null {
  if (!referrer) return null;
  try {
    const url = new URL(referrer);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.hostname.toLowerCase().replace(/^www\./, "") || null;
  } catch {
    return null;
  }
}

/** Normalises a blocked-list entry: "https://www.Example.com/path" → "example.com". Null if not a domain. */
export function normalizeDomain(input: string): string | null {
  const raw = input.trim().toLowerCase();
  if (!raw) return null;
  const host = (raw.includes("://") ? refDomainOf(raw) : raw.replace(/^www\./, "").split(/[/?#]/)[0]) ?? "";
  return /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(host) ? host : null;
}

/** A domain is blocked if it equals a listed domain or is a subdomain of one. */
export function isBlockedDomain(domain: string | null, blocked: readonly string[]): boolean {
  if (!domain) return false;
  return blocked.some((b) => domain === b || domain.endsWith(`.${b}`));
}

export function clientIp(h: Headers): string | null {
  const forwarded = h.get("x-forwarded-for")?.split(",")[0]?.trim();
  return forwarded || h.get("x-real-ip")?.trim() || null;
}

/** Keyed hash so raw IPs are never stored. Null when no salt is configured. */
export function hashIp(ip: string | null, salt: string | undefined): string | null {
  if (!ip || !salt) return null;
  return createHmac("sha256", salt).update(ip).digest("hex");
}

// Link-preview fetchers (Telegram, WhatsApp, social apps) and crawlers aren't people.
// Logging them would let a preview "click" win the click→convo country match.
const PREVIEW_BOT =
  /bot\b|crawler|spider|preview|facebookexternalhit|telegrambot|whatsapp|slackbot|discordbot|twitterbot|linkedinbot|embedly|skypeuripreview|curl\/|wget\//i;

export function isPreviewBot(userAgent: string | null): boolean {
  return !userAgent || PREVIEW_BOT.test(userAgent);
}
