-- DropForeignKey
ALTER TABLE "matches" DROP CONSTRAINT "matches_homeTeamId_fkey";

-- DropForeignKey
ALTER TABLE "matches" DROP CONSTRAINT "matches_awayTeamId_fkey";

-- AlterTable
ALTER TABLE "tournaments" ADD COLUMN     "knockoutRoundSize" INTEGER;

-- AlterTable
ALTER TABLE "matches" ADD COLUMN     "awaySourceMatchId" TEXT,
ADD COLUMN     "bracketRoundSize" INTEGER,
ADD COLUMN     "bracketSlot" INTEGER,
ADD COLUMN     "homeSourceMatchId" TEXT,
ALTER COLUMN "homeTeamId" DROP NOT NULL,
ALTER COLUMN "awayTeamId" DROP NOT NULL,
ALTER COLUMN "scheduledAt" DROP NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "matches_tournamentId_bracketRoundSize_bracketSlot_key" ON "matches"("tournamentId", "bracketRoundSize", "bracketSlot");

-- AddForeignKey
ALTER TABLE "matches" ADD CONSTRAINT "matches_homeTeamId_fkey" FOREIGN KEY ("homeTeamId") REFERENCES "teams"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "matches" ADD CONSTRAINT "matches_awayTeamId_fkey" FOREIGN KEY ("awayTeamId") REFERENCES "teams"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "matches" ADD CONSTRAINT "matches_homeSourceMatchId_fkey" FOREIGN KEY ("homeSourceMatchId") REFERENCES "matches"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "matches" ADD CONSTRAINT "matches_awaySourceMatchId_fkey" FOREIGN KEY ("awaySourceMatchId") REFERENCES "matches"("id") ON DELETE SET NULL ON UPDATE CASCADE;

