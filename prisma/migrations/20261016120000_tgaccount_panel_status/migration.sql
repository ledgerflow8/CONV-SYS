-- AlterTable: record-only status reported by the Telegram panel (PLAN.md §10.1).
ALTER TABLE "TgAccount" ADD COLUMN     "panelStatus" TEXT,
ADD COLUMN     "lastSeenAt" TIMESTAMP(3);
