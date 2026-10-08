import { PrismaClient } from "@prisma/client";

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

// Interactive transactions (ingest, locking, Add VA) make several round trips. Prisma's 5s default
// is too tight over a real network to Supabase; these are ceilings, not delays.
export const TRANSACTION_OPTIONS = { maxWait: 10_000, timeout: 20_000 } as const;

export const db = globalForPrisma.prisma ?? new PrismaClient({ transactionOptions: TRANSACTION_OPTIONS });

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = db;
