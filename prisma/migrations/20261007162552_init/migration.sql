-- CreateEnum
CREATE TYPE "Role" AS ENUM ('DIRECTOR', 'LEAD_MANAGER', 'LEAD_VA', 'VA');

-- CreateEnum
CREATE TYPE "UserStatus" AS ENUM ('ACTIVE', 'FIRED', 'DISABLED');

-- CreateEnum
CREATE TYPE "TgStatus" AS ENUM ('AVAILABLE', 'ASSIGNED', 'BANNED', 'RETIRED');

-- CreateEnum
CREATE TYPE "ConvoStatus" AS ENUM ('PENDING', 'QUALIFIED', 'REJECTED', 'REVIEW');

-- CreateEnum
CREATE TYPE "CountrySrc" AS ENUM ('PHONE', 'CLICK', 'MANUAL', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "WeekStatus" AS ENUM ('OPEN', 'LOCKED', 'PAID');

-- CreateEnum
CREATE TYPE "PayStatus" AS ENUM ('PENDING', 'SENT', 'FAILED');

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "username" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "role" "Role" NOT NULL,
    "status" "UserStatus" NOT NULL DEFAULT 'ACTIVE',
    "parentId" TEXT,
    "modelId" TEXT,
    "telegramHandle" TEXT,
    "telegramUserId" BIGINT,
    "walletAddress" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "firedAt" TIMESTAMP(3),

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Model" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "Model_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TgAccount" (
    "id" TEXT NOT NULL,
    "modelId" TEXT NOT NULL,
    "username" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "link" TEXT NOT NULL,
    "status" "TgStatus" NOT NULL DEFAULT 'AVAILABLE',
    "vaId" TEXT,
    "sessionRef" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TgAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TgAssignment" (
    "id" TEXT NOT NULL,
    "tgAccountId" TEXT NOT NULL,
    "vaId" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endedAt" TIMESTAMP(3),
    "endReason" TEXT,

    CONSTRAINT "TgAssignment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TrackingLink" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "vaId" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "TrackingLink_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LinkClick" (
    "id" TEXT NOT NULL,
    "linkId" TEXT NOT NULL,
    "vaId" TEXT NOT NULL,
    "tgAccountId" TEXT,
    "country" TEXT,
    "referrer" TEXT,
    "refDomain" TEXT,
    "blocked" BOOLEAN NOT NULL DEFAULT false,
    "ipHash" TEXT,
    "userAgent" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LinkClick_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Convo" (
    "id" TEXT NOT NULL,
    "tgAccountId" TEXT NOT NULL,
    "peerId" TEXT NOT NULL,
    "peerPhone" TEXT,
    "vaId" TEXT,
    "leadVaId" TEXT,
    "leadManagerId" TEXT,
    "modelId" TEXT,
    "weekId" TEXT,
    "country" TEXT,
    "countrySource" "CountrySrc" NOT NULL DEFAULT 'UNKNOWN',
    "clickId" TEXT,
    "source" TEXT,
    "firstMsgAt" TIMESTAMP(3) NOT NULL,
    "repliedAt" TIMESTAMP(3),
    "status" "ConvoStatus" NOT NULL DEFAULT 'PENDING',
    "rejectReason" TEXT,
    "qualifiedAt" TIMESTAMP(3),
    "vaCents" INTEGER NOT NULL DEFAULT 0,
    "leadVaCents" INTEGER NOT NULL DEFAULT 0,
    "lmCents" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Convo_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Week" (
    "id" TEXT NOT NULL,
    "startsAt" TIMESTAMP(3) NOT NULL,
    "endsAt" TIMESTAMP(3) NOT NULL,
    "status" "WeekStatus" NOT NULL DEFAULT 'OPEN',

    CONSTRAINT "Week_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Payout" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "weekId" TEXT NOT NULL,
    "role" "Role" NOT NULL,
    "convos" INTEGER NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "walletAddress" TEXT,
    "status" "PayStatus" NOT NULL DEFAULT 'PENDING',
    "txHash" TEXT,
    "paidAt" TIMESTAMP(3),

    CONSTRAINT "Payout_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InviteToken" (
    "id" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "passwordEnc" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),

    CONSTRAINT "InviteToken_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Resource" (
    "id" TEXT NOT NULL,
    "modelId" TEXT,
    "section" TEXT NOT NULL,
    "category" TEXT,
    "title" TEXT NOT NULL,
    "url" TEXT,
    "filePath" TEXT,
    "sort" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Resource_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Setting" (
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,

    CONSTRAINT "Setting_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" TEXT NOT NULL,
    "actorId" TEXT,
    "action" TEXT NOT NULL,
    "target" TEXT,
    "meta" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_username_key" ON "User"("username");

-- CreateIndex
CREATE UNIQUE INDEX "User_telegramUserId_key" ON "User"("telegramUserId");

-- CreateIndex
CREATE INDEX "User_parentId_idx" ON "User"("parentId");

-- CreateIndex
CREATE INDEX "User_role_status_idx" ON "User"("role", "status");

-- CreateIndex
CREATE UNIQUE INDEX "Model_name_key" ON "Model"("name");

-- CreateIndex
CREATE UNIQUE INDEX "TgAccount_username_key" ON "TgAccount"("username");

-- CreateIndex
CREATE UNIQUE INDEX "TgAccount_vaId_key" ON "TgAccount"("vaId");

-- CreateIndex
CREATE INDEX "TgAccount_modelId_status_idx" ON "TgAccount"("modelId", "status");

-- CreateIndex
CREATE INDEX "TgAssignment_tgAccountId_startedAt_idx" ON "TgAssignment"("tgAccountId", "startedAt");

-- CreateIndex
CREATE INDEX "TgAssignment_vaId_idx" ON "TgAssignment"("vaId");

-- CreateIndex
CREATE UNIQUE INDEX "TrackingLink_slug_key" ON "TrackingLink"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "TrackingLink_vaId_key" ON "TrackingLink"("vaId");

-- CreateIndex
CREATE INDEX "LinkClick_vaId_tgAccountId_createdAt_idx" ON "LinkClick"("vaId", "tgAccountId", "createdAt");

-- CreateIndex
CREATE INDEX "Convo_vaId_weekId_status_idx" ON "Convo"("vaId", "weekId", "status");

-- CreateIndex
CREATE INDEX "Convo_leadVaId_weekId_status_idx" ON "Convo"("leadVaId", "weekId", "status");

-- CreateIndex
CREATE INDEX "Convo_leadManagerId_weekId_status_idx" ON "Convo"("leadManagerId", "weekId", "status");

-- CreateIndex
CREATE INDEX "Convo_status_idx" ON "Convo"("status");

-- CreateIndex
CREATE UNIQUE INDEX "Convo_tgAccountId_peerId_key" ON "Convo"("tgAccountId", "peerId");

-- CreateIndex
CREATE UNIQUE INDEX "Week_startsAt_key" ON "Week"("startsAt");

-- CreateIndex
CREATE UNIQUE INDEX "Payout_userId_weekId_key" ON "Payout"("userId", "weekId");

-- CreateIndex
CREATE UNIQUE INDEX "InviteToken_tokenHash_key" ON "InviteToken"("tokenHash");

-- CreateIndex
CREATE INDEX "AuditLog_createdAt_idx" ON "AuditLog"("createdAt");

-- AddForeignKey
ALTER TABLE "User" ADD CONSTRAINT "User_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "User" ADD CONSTRAINT "User_modelId_fkey" FOREIGN KEY ("modelId") REFERENCES "Model"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "User" ADD CONSTRAINT "User_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TgAccount" ADD CONSTRAINT "TgAccount_modelId_fkey" FOREIGN KEY ("modelId") REFERENCES "Model"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TgAccount" ADD CONSTRAINT "TgAccount_vaId_fkey" FOREIGN KEY ("vaId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TgAssignment" ADD CONSTRAINT "TgAssignment_tgAccountId_fkey" FOREIGN KEY ("tgAccountId") REFERENCES "TgAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TgAssignment" ADD CONSTRAINT "TgAssignment_vaId_fkey" FOREIGN KEY ("vaId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TrackingLink" ADD CONSTRAINT "TrackingLink_vaId_fkey" FOREIGN KEY ("vaId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LinkClick" ADD CONSTRAINT "LinkClick_linkId_fkey" FOREIGN KEY ("linkId") REFERENCES "TrackingLink"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LinkClick" ADD CONSTRAINT "LinkClick_vaId_fkey" FOREIGN KEY ("vaId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LinkClick" ADD CONSTRAINT "LinkClick_tgAccountId_fkey" FOREIGN KEY ("tgAccountId") REFERENCES "TgAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Convo" ADD CONSTRAINT "Convo_tgAccountId_fkey" FOREIGN KEY ("tgAccountId") REFERENCES "TgAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Convo" ADD CONSTRAINT "Convo_vaId_fkey" FOREIGN KEY ("vaId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Convo" ADD CONSTRAINT "Convo_leadVaId_fkey" FOREIGN KEY ("leadVaId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Convo" ADD CONSTRAINT "Convo_leadManagerId_fkey" FOREIGN KEY ("leadManagerId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Convo" ADD CONSTRAINT "Convo_modelId_fkey" FOREIGN KEY ("modelId") REFERENCES "Model"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Convo" ADD CONSTRAINT "Convo_weekId_fkey" FOREIGN KEY ("weekId") REFERENCES "Week"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Convo" ADD CONSTRAINT "Convo_clickId_fkey" FOREIGN KEY ("clickId") REFERENCES "LinkClick"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Payout" ADD CONSTRAINT "Payout_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Payout" ADD CONSTRAINT "Payout_weekId_fkey" FOREIGN KEY ("weekId") REFERENCES "Week"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InviteToken" ADD CONSTRAINT "InviteToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Resource" ADD CONSTRAINT "Resource_modelId_fkey" FOREIGN KEY ("modelId") REFERENCES "Model"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
