// Public tracking link (PLAN.md §6): log the click, 302 to the VA's current Telegram account.
// The link follows the VA, so after a ban/reassign it automatically points at their new account.
import { NextResponse, type NextRequest } from "next/server";
import { db } from "@/lib/db";
import { clientIp, countryFromHeaders, hashIp, isBlockedDomain, isPreviewBot, refDomainOf } from "@/lib/clicks";
import { getSetting } from "@/lib/settings";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" };

function unavailable(req: NextRequest) {
  return NextResponse.redirect(new URL("/link-unavailable", req.url), { status: 302, headers: NO_STORE });
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  if (!/^[a-z0-9]{4,32}$/.test(slug)) return unavailable(req);

  const link = await db.trackingLink.findUnique({
    where: { slug },
    select: {
      id: true,
      active: true,
      vaId: true,
      va: { select: { status: true, tgAccount: { select: { id: true, link: true, status: true } } } },
    },
  });
  const account = link?.va.tgAccount;
  if (!link?.active || link.va.status !== "ACTIVE" || !account || account.status !== "ASSIGNED") {
    return unavailable(req);
  }
  // Accounts are validated as https://t.me/... on the way in; re-check so a bad row can't become an open redirect.
  if (!account.link.startsWith("https://t.me/")) return unavailable(req);

  const userAgent = req.headers.get("user-agent");
  if (!isPreviewBot(userAgent)) {
    try {
      const referrer = req.headers.get("referer");
      const refDomain = refDomainOf(referrer);
      await db.linkClick.create({
        data: {
          linkId: link.id,
          vaId: link.vaId,
          tgAccountId: account.id,
          country: countryFromHeaders(req.headers),
          referrer: referrer?.slice(0, 1000) ?? null,
          refDomain,
          blocked: isBlockedDomain(refDomain, await getSetting("blockedDomains")),
          ipHash: hashIp(clientIp(req.headers), process.env.IP_HASH_SALT),
          userAgent: userAgent?.slice(0, 512) ?? null,
        },
      });
    } catch (e) {
      // Never lose the visitor because logging failed.
      console.error("[v] click log failed", e instanceof Error ? e.message : e);
    }
  }

  return NextResponse.redirect(account.link, { status: 302, headers: NO_STORE });
}
