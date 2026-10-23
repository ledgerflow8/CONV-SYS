-- AlterTable
ALTER TABLE "Payout" ADD COLUMN     "bonusCents" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "LeaderboardWin" (
    "id" TEXT NOT NULL,
    "weekId" TEXT NOT NULL,
    "board" "Role" NOT NULL,
    "rank" INTEGER NOT NULL,
    "userId" TEXT NOT NULL,
    "convos" INTEGER NOT NULL,
    "prizeCents" INTEGER NOT NULL,

    CONSTRAINT "LeaderboardWin_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "LeaderboardWin_weekId_board_rank_key" ON "LeaderboardWin"("weekId", "board", "rank");

-- CreateIndex
CREATE UNIQUE INDEX "LeaderboardWin_weekId_board_userId_key" ON "LeaderboardWin"("weekId", "board", "userId");

-- AddForeignKey
ALTER TABLE "LeaderboardWin" ADD CONSTRAINT "LeaderboardWin_weekId_fkey" FOREIGN KEY ("weekId") REFERENCES "Week"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LeaderboardWin" ADD CONSTRAINT "LeaderboardWin_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
