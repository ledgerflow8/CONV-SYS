-- DropForeignKey
ALTER TABLE "Convo" DROP CONSTRAINT "Convo_tgAccountId_fkey";

-- DropIndex
DROP INDEX "Convo_tgAccountId_peerId_key";

-- AlterTable
ALTER TABLE "Convo" ADD COLUMN     "accountRef" TEXT NOT NULL,
ADD COLUMN     "reviewReason" TEXT,
ALTER COLUMN "tgAccountId" DROP NOT NULL;

-- CreateIndex
CREATE INDEX "Convo_tgAccountId_idx" ON "Convo"("tgAccountId");

-- CreateIndex
CREATE UNIQUE INDEX "Convo_accountRef_peerId_key" ON "Convo"("accountRef", "peerId");

-- AddForeignKey
ALTER TABLE "Convo" ADD CONSTRAINT "Convo_tgAccountId_fkey" FOREIGN KEY ("tgAccountId") REFERENCES "TgAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE;

