-- CreateIndex
CREATE INDEX "match_events_matchId_type_idx" ON "match_events"("matchId", "type");

-- CreateIndex
CREATE INDEX "match_events_primaryUserId_idx" ON "match_events"("primaryUserId");

-- CreateIndex
CREATE INDEX "match_lineups_userId_idx" ON "match_lineups"("userId");

-- CreateIndex
CREATE INDEX "matches_tournamentId_status_idx" ON "matches"("tournamentId", "status");

-- CreateIndex
CREATE INDEX "matches_scheduledAt_status_idx" ON "matches"("scheduledAt", "status");

-- CreateIndex
CREATE INDEX "matches_homeTeamId_idx" ON "matches"("homeTeamId");

-- CreateIndex
CREATE INDEX "matches_awayTeamId_idx" ON "matches"("awayTeamId");

-- CreateIndex
CREATE INDEX "notifications_userId_read_idx" ON "notifications"("userId", "read");

-- CreateIndex
CREATE INDEX "team_invitations_userId_status_idx" ON "team_invitations"("userId", "status");

-- CreateIndex
CREATE INDEX "team_invitations_teamId_status_idx" ON "team_invitations"("teamId", "status");

-- CreateIndex
CREATE INDEX "team_memberships_userId_status_idx" ON "team_memberships"("userId", "status");

-- CreateIndex
CREATE INDEX "team_memberships_teamId_status_idx" ON "team_memberships"("teamId", "status");

-- CreateIndex
CREATE INDEX "tournament_teams_teamId_idx" ON "tournament_teams"("teamId");

-- CreateIndex
CREATE INDEX "tournaments_status_isPublished_idx" ON "tournaments"("status", "isPublished");

-- CreateIndex
CREATE INDEX "tournaments_deletedAt_idx" ON "tournaments"("deletedAt");
