-- Add shortCode column
ALTER TABLE "teams" ADD COLUMN "shortCode" TEXT;

-- Remove awayColour column
ALTER TABLE "teams" DROP COLUMN "awayColour";
