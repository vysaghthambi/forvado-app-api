import type { Prisma } from '@prisma/client'

/** Human label for a knockout round, keyed by how many matches are in it. */
export function roundLabel(matchesInRound: number): string {
  switch (matchesInRound) {
    case 1: return 'FINAL'
    case 2: return 'SEMI-FINAL'
    case 4: return 'QUARTER FINAL'
    case 8: return 'PRE-QUARTER FINAL'
    case 16: return 'ROUND OF 32'
    case 32: return 'ROUND OF 64'
    case 64: return 'ROUND OF 128'
    default: return `ROUND OF ${matchesInRound * 2}`
  }
}

export function isPowerOfTwo(n: number): boolean {
  return Number.isInteger(n) && n > 0 && (n & (n - 1)) === 0
}

interface MatchInput {
  status: string
  homeTeamId: string | null
  awayTeamId: string | null
  homeScore: number
  awayScore: number
  homePenaltyScore: number | null
  awayPenaltyScore: number | null
}

/** True once the score (incl. penalties) picks a side — no further phase is needed. */
export function hasDecisiveResult(m: Pick<MatchInput, 'homeScore' | 'awayScore' | 'homePenaltyScore' | 'awayPenaltyScore'>): boolean {
  if (m.homeScore !== m.awayScore) return true
  return m.homePenaltyScore !== null && m.awayPenaltyScore !== null && m.homePenaltyScore !== m.awayPenaltyScore
}

/** Winning team id for a COMPLETED match, or null if not completed / not decisive. */
export function getMatchWinnerTeamId(m: MatchInput): string | null {
  if (m.status !== 'COMPLETED') return null
  if (!m.homeTeamId || !m.awayTeamId) return null
  if (!hasDecisiveResult(m)) return null
  if (m.homeScore !== m.awayScore) return m.homeScore > m.awayScore ? m.homeTeamId : m.awayTeamId
  return m.homePenaltyScore! > m.awayPenaltyScore! ? m.homeTeamId : m.awayTeamId
}

interface RoundDefaults {
  matchTime: number
  playingMembers: number
  maxSubstitutes: number
  venue: string | null
}

/**
 * Creates every round after round 1 (bracketRoundSize halving down to 1) as TBD
 * placeholder matches, wiring each pair's winner into the next round's slot.
 * Call once all `startingRoundSize` round-1 matches already exist in the DB.
 */
export async function generateBracketSkeleton(
  tx: Prisma.TransactionClient,
  tournamentId: string,
  startingRoundSize: number,
  defaults: RoundDefaults,
): Promise<void> {
  const lastMatch = await tx.match.findFirst({
    where: { tournamentId },
    orderBy: { matchOrder: 'desc' },
    select: { matchOrder: true },
  })
  let matchOrder = (lastMatch?.matchOrder ?? 0) + 1

  let previousRound = await tx.match.findMany({
    where: { tournamentId, bracketRoundSize: startingRoundSize },
    orderBy: { bracketSlot: 'asc' },
    select: { id: true, bracketSlot: true },
  })

  let size = startingRoundSize / 2
  while (size >= 1) {
    const created: { id: string; bracketSlot: number | null }[] = []
    for (let slot = 1; slot <= size; slot++) {
      const homeSource = previousRound.find((m) => m.bracketSlot === slot * 2 - 1)
      const awaySource = previousRound.find((m) => m.bracketSlot === slot * 2)
      const created_ = await tx.match.create({
        data: {
          tournamentId,
          matchOrder: matchOrder++,
          round: roundLabel(size),
          bracketRoundSize: size,
          bracketSlot: slot,
          homeSourceMatchId: homeSource?.id ?? null,
          awaySourceMatchId: awaySource?.id ?? null,
          matchTime: defaults.matchTime,
          playingMembers: defaults.playingMembers,
          maxSubstitutes: defaults.maxSubstitutes,
          venue: defaults.venue,
        },
        select: { id: true, bracketSlot: true },
      })
      created.push(created_)
    }
    previousRound = created
    size = size / 2
  }
}

/** If round 1 has just been fully populated, build out the rest of the bracket. */
export async function maybeGenerateBracketSkeleton(
  tx: Prisma.TransactionClient,
  tournamentId: string,
  knockoutRoundSize: number,
  defaults: RoundDefaults,
): Promise<void> {
  const count = await tx.match.count({ where: { tournamentId, bracketRoundSize: knockoutRoundSize } })
  if (count === knockoutRoundSize) {
    await generateBracketSkeleton(tx, tournamentId, knockoutRoundSize, defaults)
  }
}

/** After a bracket match completes, fill in the winner's slot on the next-round match. */
export async function advanceBracketOnCompletion(tx: Prisma.TransactionClient, matchId: string): Promise<void> {
  const match = await tx.match.findUnique({
    where: { id: matchId },
    select: {
      bracketRoundSize: true,
      homeTeamId: true, awayTeamId: true, status: true,
      homeScore: true, awayScore: true, homePenaltyScore: true, awayPenaltyScore: true,
    },
  })
  if (!match || match.bracketRoundSize === null) return

  const winnerId = getMatchWinnerTeamId(match)
  if (!winnerId) return

  const nextAsHome = await tx.match.findFirst({ where: { homeSourceMatchId: matchId }, select: { id: true } })
  if (nextAsHome) {
    await tx.match.update({ where: { id: nextAsHome.id }, data: { homeTeamId: winnerId } })
    return
  }
  const nextAsAway = await tx.match.findFirst({ where: { awaySourceMatchId: matchId }, select: { id: true } })
  if (nextAsAway) {
    await tx.match.update({ where: { id: nextAsAway.id }, data: { awayTeamId: winnerId } })
  }
}
