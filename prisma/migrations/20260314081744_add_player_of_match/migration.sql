-- AlterTable
ALTER TABLE "matches" ADD COLUMN     "playerOfMatchId" TEXT;

-- AddForeignKey
ALTER TABLE "matches" ADD CONSTRAINT "matches_playerOfMatchId_fkey" FOREIGN KEY ("playerOfMatchId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
