-- Migrate any users with COORDINATOR role to TEAM_OWNER
UPDATE "users" SET "role" = 'TEAM_OWNER' WHERE "role" = 'COORDINATOR';

-- Migrate any tournaments with REGISTRATION status to UPCOMING
UPDATE "tournaments" SET "status" = 'UPCOMING' WHERE "status" = 'REGISTRATION';

-- Recreate Role enum without COORDINATOR
ALTER TYPE "Role" RENAME TO "Role_old";
CREATE TYPE "Role" AS ENUM ('PLAYER', 'TEAM_OWNER', 'ADMIN');
ALTER TABLE "users" ALTER COLUMN "role" TYPE "Role" USING "role"::text::"Role";
DROP TYPE "Role_old";

-- Recreate TournamentStatus enum without REGISTRATION
ALTER TYPE "TournamentStatus" RENAME TO "TournamentStatus_old";
CREATE TYPE "TournamentStatus" AS ENUM ('DRAFT', 'UPCOMING', 'ONGOING', 'COMPLETED');
ALTER TABLE "tournaments" ALTER COLUMN "status" TYPE "TournamentStatus" USING "status"::text::"TournamentStatus";
DROP TYPE "TournamentStatus_old";
