import { prisma } from '../lib/prisma.js'

export interface StandingRow {
  teamId: string
  teamName: string
  badgeUrl: string | null
  played: number
  won: number
  drawn: number
  lost: number
  goalsFor: number
  goalsAgainst: number
  goalDifference: number
  points: number
  form: ('W' | 'D' | 'L')[]
}

function buildRow(teamId: string, teamName: string, badgeUrl: string | null): StandingRow {
  return { teamId, teamName, badgeUrl, played: 0, won: 0, drawn: 0, lost: 0, goalsFor: 0, goalsAgainst: 0, goalDifference: 0, points: 0, form: [] }
}

function sortRows(rows: StandingRow[]): StandingRow[] {
  return rows.sort((a, b) => {
    if (b.points !== a.points) return b.points - a.points
    if (b.goalDifference !== a.goalDifference) return b.goalDifference - a.goalDifference
    if (b.goalsFor !== a.goalsFor) return b.goalsFor - a.goalsFor
    return a.teamName.localeCompare(b.teamName)
  })
}

type MatchInput = {
  homeTeamId: string | null
  awayTeamId: string | null
  homeScore: number
  awayScore: number
  homePenaltyScore: number | null
  awayPenaltyScore: number | null
  status: string
}

function applyMatchResult(home: StandingRow, away: StandingRow, m: MatchInput) {
  home.played++; away.played++
  home.goalsFor += m.homeScore; home.goalsAgainst += m.awayScore
  away.goalsFor += m.awayScore; away.goalsAgainst += m.homeScore

  if (m.homeScore > m.awayScore) {
    home.won++; home.points += 3; away.lost++
    home.form.push('W'); away.form.push('L')
  } else if (m.homeScore < m.awayScore) {
    away.won++; away.points += 3; home.lost++
    away.form.push('W'); home.form.push('L')
  } else if (m.homePenaltyScore !== null && m.awayPenaltyScore !== null) {
    if (m.homePenaltyScore > m.awayPenaltyScore) {
      home.won++; home.points += 3; away.lost++
      home.form.push('W'); away.form.push('L')
    } else {
      away.won++; away.points += 3; home.lost++
      away.form.push('W'); home.form.push('L')
    }
  } else {
    home.drawn++; home.points += 1; away.drawn++; away.points += 1
    home.form.push('D'); away.form.push('D')
  }
}

// ─── Pure computation (no DB calls) ───────────────────────────────────────────
// Use these when you already have the tournament data in memory.

export function computeLeagueStandings(
  teams: { teamId: string; team: { id: string; name: string; badgeUrl: string | null } }[],
  matches: MatchInput[],
): StandingRow[] {
  const map = new Map<string, StandingRow>()
  for (const tt of teams) {
    map.set(tt.teamId, buildRow(tt.teamId, tt.team.name, tt.team.badgeUrl))
  }
  for (const m of matches) {
    if (m.status !== 'COMPLETED' || !m.homeTeamId || !m.awayTeamId) continue
    const home = map.get(m.homeTeamId)
    const away = map.get(m.awayTeamId)
    if (!home || !away) continue
    applyMatchResult(home, away, m)
  }
  for (const row of map.values()) {
    row.goalDifference = row.goalsFor - row.goalsAgainst
    row.form = row.form.slice(-5)
  }
  return sortRows(Array.from(map.values()))
}

export function computeGroupStandings(
  groups: { id: string; name: string }[],
  teams: { teamId: string; groupId: string | null; team: { id: string; name: string; badgeUrl: string | null } }[],
  matches: (MatchInput & { groupId: string | null })[],
): { groupId: string; groupName: string; rows: StandingRow[] }[] {
  const matchesByGroup = new Map<string, (MatchInput & { groupId: string | null })[]>()
  for (const m of matches) {
    if (m.status !== 'COMPLETED' || !m.groupId) continue
    const arr = matchesByGroup.get(m.groupId) ?? []
    arr.push(m)
    matchesByGroup.set(m.groupId, arr)
  }

  return groups.map((g) => {
    const map = new Map<string, StandingRow>()
    for (const tt of teams) {
      if (tt.groupId === g.id) map.set(tt.teamId, buildRow(tt.teamId, tt.team.name, tt.team.badgeUrl))
    }
    for (const m of matchesByGroup.get(g.id) ?? []) {
      if (!m.homeTeamId || !m.awayTeamId) continue
      const home = map.get(m.homeTeamId)
      const away = map.get(m.awayTeamId)
      if (!home || !away) continue
      applyMatchResult(home, away, m)
    }
    for (const row of map.values()) {
      row.goalDifference = row.goalsFor - row.goalsAgainst
      row.form = row.form.slice(-5)
    }
    return { groupId: g.id, groupName: g.name, rows: sortRows(Array.from(map.values())) }
  })
}

// ─── DB-backed versions (used by API route) ───────────────────────────────────
// No server-side caching — always computed fresh; the frontend caches via TanStack Query.

export async function calculateStandings(tournamentId: string): Promise<StandingRow[]> {
  const tournament = await prisma.tournament.findUnique({
    where: { id: tournamentId, deletedAt: null },
    include: {
      teams: { include: { team: { select: { id: true, name: true, badgeUrl: true } } } },
      matches: {
        where: { status: 'COMPLETED' },
        select: { homeTeamId: true, awayTeamId: true, homeScore: true, awayScore: true, homePenaltyScore: true, awayPenaltyScore: true, status: true },
        orderBy: { matchOrder: 'asc' },
      },
    },
  })
  if (!tournament) return []
  return computeLeagueStandings(tournament.teams, tournament.matches)
}

export async function calculateGroupStandings(
  tournamentId: string,
): Promise<{ groupId: string; groupName: string; rows: StandingRow[] }[]> {
  const [groups, completedMatches] = await Promise.all([
    prisma.tournamentGroup.findMany({
      where: { tournamentId },
      include: {
        teams: { include: { team: { select: { id: true, name: true, badgeUrl: true } } } },
      },
      orderBy: { name: 'asc' },
    }),
    prisma.match.findMany({
      where: { tournamentId, status: 'COMPLETED' },
      select: { groupId: true, homeTeamId: true, awayTeamId: true, homeScore: true, awayScore: true, homePenaltyScore: true, awayPenaltyScore: true, status: true },
      orderBy: { matchOrder: 'asc' },
    }),
  ])

  const teams = groups.flatMap((g) => g.teams.map((t) => ({ ...t, groupId: g.id })))
  return computeGroupStandings(groups, teams, completedMatches)
}
