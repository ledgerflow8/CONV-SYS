// GET /api/health: shows which commit and branch Vercel deployed. No data, no secrets.
export const dynamic = "force-dynamic";

export function GET() {
  return Response.json(
    {
      ok: true,
      commit: process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) ?? "local",
      branch: process.env.VERCEL_GIT_COMMIT_REF ?? "local",
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
