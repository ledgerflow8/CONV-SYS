// First-line route guard: no valid session → /login; wrong role → own home.
// Layouts re-check against the DB (status, role) via requireRole().
import { NextResponse, type NextRequest } from "next/server";
import { ROLE_HOME, roleForPath } from "@/lib/auth/roles";
import { SESSION_COOKIE, verifySession } from "@/lib/auth/token";

export async function middleware(req: NextRequest) {
  const required = roleForPath(req.nextUrl.pathname);
  if (!required) return NextResponse.next();

  const token = req.cookies.get(SESSION_COOKIE)?.value;
  const claims = token ? await verifySession(token) : null;
  if (!claims) return NextResponse.redirect(new URL("/login", req.url));
  if (claims.role !== required) return NextResponse.redirect(new URL(ROLE_HOME[claims.role], req.url));
  return NextResponse.next();
}

export const config = {
  matcher: ["/director/:path*", "/lead-manager/:path*", "/lead-va/:path*", "/va/:path*"],
};
