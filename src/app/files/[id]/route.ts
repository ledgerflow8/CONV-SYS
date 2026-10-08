// /files/<resourceId>[?inline=1] → scope check → 302 to a 60-second signed Supabase URL.
import { getCurrentUser } from "@/lib/auth/session";
import { resourceFileUrl } from "@/lib/resources";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return new Response("Not found", { status: 404 });
  const { id } = await params;
  const inline = new URL(req.url).searchParams.get("inline") === "1";
  const url = await resourceFileUrl(user, id, { inline });
  if (!url) return new Response("Not found", { status: 404 });
  return new Response(null, { status: 302, headers: { Location: url, "Cache-Control": "private, no-store" } });
}
