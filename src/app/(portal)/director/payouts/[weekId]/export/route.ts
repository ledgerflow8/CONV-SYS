// Director → week payouts as CSV, for sending from the agency wallet.
import { getCurrentUser } from "@/lib/auth/session";
import { ROLE_LABEL } from "@/lib/auth/roles";
import { db } from "@/lib/db";
import { centsToDollars } from "@/lib/money";
import { csvCell } from "@/lib/payouts";
import { scopeFor } from "@/lib/scope";
import { getSetting } from "@/lib/settings";
import { audit } from "@/lib/audit";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: Promise<{ weekId: string }> }) {
  const user = await getCurrentUser();
  if (!user || user.role !== "DIRECTOR") return new Response("Not found", { status: 404 });

  const { weekId } = await params;
  const week = await db.week.findUnique({ where: { id: weekId } });
  if (!week || week.status === "OPEN") return new Response("Not found", { status: 404 });

  const [currency, payouts] = await Promise.all([
    getSetting("payoutCurrency"),
    db.payout.findMany({
      where: { AND: [scopeFor(user).payout, { weekId }] },
      orderBy: [{ role: "asc" }, { amountCents: "desc" }],
      include: { user: { select: { username: true } } },
    }),
  ]);

  const header = ["username", "role", "convos", `amount_${currency.split(" ")[0].toLowerCase()}`, "amount_cents", "wallet", "status", "tx_hash"];
  const rows = payouts.map((p) =>
    [p.user.username, ROLE_LABEL[p.role], p.convos, centsToDollars(p.amountCents), p.amountCents, p.walletAddress ?? "", p.status, p.txHash ?? ""].map(csvCell).join(","),
  );
  const body = [header.map(csvCell).join(","), ...rows].join("\r\n") + "\r\n";

  await db.$transaction((tx) => audit(tx, { actorId: user.id, action: "payout.export", target: weekId, meta: { rows: payouts.length } }));

  const date = week.startsAt.toISOString().slice(0, 10);
  return new Response(body, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="payouts-week-${date}.csv"`,
      "Cache-Control": "no-store",
    },
  });
}
