-- The stable numeric Telegram id, so convo + status ingest match the account across username changes.
-- Nullable + backfilled opportunistically as the panel reports (NULLs are distinct, so UNIQUE is fine).
ALTER TABLE "TgAccount" ADD COLUMN "tgUserId" BIGINT;
CREATE UNIQUE INDEX "TgAccount_tgUserId_key" ON "TgAccount"("tgUserId");
