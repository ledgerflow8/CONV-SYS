-- Auto-registered accounts arrive before a Director picks a model, and may not have a username yet.
-- Both become nullable; the unique index on username still holds (Postgres treats NULLs as distinct).
ALTER TABLE "TgAccount" ALTER COLUMN "modelId" DROP NOT NULL;
ALTER TABLE "TgAccount" ALTER COLUMN "username" DROP NOT NULL;
