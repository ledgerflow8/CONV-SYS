import type { Prisma } from "@prisma/client";

export function audit(
  tx: Prisma.TransactionClient,
  entry: { actorId: string | null; action: string; target?: string; meta?: Prisma.InputJsonValue },
) {
  return tx.auditLog.create({ data: entry });
}
