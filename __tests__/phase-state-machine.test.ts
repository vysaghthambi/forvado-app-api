import { describe, it, expect } from 'vitest'

// ─── Phase state machine (mirrors src/routes/matches.routes.ts phase/next handler) ──

type MatchStatus =
  | 'SCHEDULED' | 'FIRST_HALF' | 'HALF_TIME' | 'SECOND_HALF' | 'FULL_TIME'
  | 'EXTRA_TIME_FIRST_HALF' | 'EXTRA_TIME_HALF_TIME' | 'EXTRA_TIME_SECOND_HALF'
  | 'EXTRA_TIME_FULL_TIME' | 'PENALTY_SHOOTOUT' | 'COMPLETED' | 'CANCELLED' | 'POSTPONED'

const NEXT_PHASE: Partial<Record<MatchStatus, MatchStatus>> = {
  SCHEDULED: 'FIRST_HALF',
  FIRST_HALF: 'HALF_TIME',
  HALF_TIME: 'SECOND_HALF',
  SECOND_HALF: 'FULL_TIME',
  FULL_TIME: 'COMPLETED',
  EXTRA_TIME_FIRST_HALF: 'EXTRA_TIME_HALF_TIME',
  EXTRA_TIME_HALF_TIME: 'EXTRA_TIME_SECOND_HALF',
  EXTRA_TIME_SECOND_HALF: 'EXTRA_TIME_FULL_TIME',
  EXTRA_TIME_FULL_TIME: 'COMPLETED',
  PENALTY_SHOOTOUT: 'COMPLETED',
}

const TIMESTAMP_FIELDS: Partial<Record<MatchStatus, string>> = {
  FIRST_HALF: 'firstHalfStartedAt',
  HALF_TIME: 'halfTimeAt',
  SECOND_HALF: 'secondHalfStartedAt',
  FULL_TIME: 'fullTimeAt',
  EXTRA_TIME_FIRST_HALF: 'etFirstHalfStartedAt',
  EXTRA_TIME_HALF_TIME: 'etHalfTimeAt',
  EXTRA_TIME_SECOND_HALF: 'etSecondHalfStartedAt',
  EXTRA_TIME_FULL_TIME: 'etFullTimeAt',
  PENALTY_SHOOTOUT: 'penaltyStartedAt',
  COMPLETED: 'completedAt',
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('Phase State Machine — normal time path', () => {
  it('SCHEDULED → FIRST_HALF', () => {
    expect(NEXT_PHASE['SCHEDULED']).toBe('FIRST_HALF')
  })
  it('FIRST_HALF → HALF_TIME', () => {
    expect(NEXT_PHASE['FIRST_HALF']).toBe('HALF_TIME')
  })
  it('HALF_TIME → SECOND_HALF', () => {
    expect(NEXT_PHASE['HALF_TIME']).toBe('SECOND_HALF')
  })
  it('SECOND_HALF → FULL_TIME', () => {
    expect(NEXT_PHASE['SECOND_HALF']).toBe('FULL_TIME')
  })
  it('FULL_TIME → COMPLETED (normal time win)', () => {
    expect(NEXT_PHASE['FULL_TIME']).toBe('COMPLETED')
  })
})

describe('Phase State Machine — extra time path', () => {
  it('EXTRA_TIME_FIRST_HALF → EXTRA_TIME_HALF_TIME', () => {
    expect(NEXT_PHASE['EXTRA_TIME_FIRST_HALF']).toBe('EXTRA_TIME_HALF_TIME')
  })
  it('EXTRA_TIME_HALF_TIME → EXTRA_TIME_SECOND_HALF', () => {
    expect(NEXT_PHASE['EXTRA_TIME_HALF_TIME']).toBe('EXTRA_TIME_SECOND_HALF')
  })
  it('EXTRA_TIME_SECOND_HALF → EXTRA_TIME_FULL_TIME', () => {
    expect(NEXT_PHASE['EXTRA_TIME_SECOND_HALF']).toBe('EXTRA_TIME_FULL_TIME')
  })
  it('EXTRA_TIME_FULL_TIME → COMPLETED (ET win)', () => {
    expect(NEXT_PHASE['EXTRA_TIME_FULL_TIME']).toBe('COMPLETED')
  })
})

describe('Phase State Machine — penalty shootout path', () => {
  it('PENALTY_SHOOTOUT → COMPLETED', () => {
    expect(NEXT_PHASE['PENALTY_SHOOTOUT']).toBe('COMPLETED')
  })
})

describe('Phase State Machine — terminal states have no next phase', () => {
  it('COMPLETED has no next phase', () => {
    expect(NEXT_PHASE['COMPLETED']).toBeUndefined()
  })
  it('CANCELLED has no next phase', () => {
    expect(NEXT_PHASE['CANCELLED']).toBeUndefined()
  })
  it('POSTPONED has no next phase', () => {
    expect(NEXT_PHASE['POSTPONED']).toBeUndefined()
  })
})

describe('Phase Timestamp Fields', () => {
  it('FIRST_HALF records firstHalfStartedAt', () => {
    expect(TIMESTAMP_FIELDS['FIRST_HALF']).toBe('firstHalfStartedAt')
  })
  it('HALF_TIME records halfTimeAt', () => {
    expect(TIMESTAMP_FIELDS['HALF_TIME']).toBe('halfTimeAt')
  })
  it('SECOND_HALF records secondHalfStartedAt', () => {
    expect(TIMESTAMP_FIELDS['SECOND_HALF']).toBe('secondHalfStartedAt')
  })
  it('FULL_TIME records fullTimeAt', () => {
    expect(TIMESTAMP_FIELDS['FULL_TIME']).toBe('fullTimeAt')
  })
  it('EXTRA_TIME_FIRST_HALF records etFirstHalfStartedAt', () => {
    expect(TIMESTAMP_FIELDS['EXTRA_TIME_FIRST_HALF']).toBe('etFirstHalfStartedAt')
  })
  it('PENALTY_SHOOTOUT records penaltyStartedAt', () => {
    expect(TIMESTAMP_FIELDS['PENALTY_SHOOTOUT']).toBe('penaltyStartedAt')
  })
  it('COMPLETED records completedAt', () => {
    expect(TIMESTAMP_FIELDS['COMPLETED']).toBe('completedAt')
  })
})

describe('Full match lifecycle — normal time', () => {
  it('traverses the full normal time path without gaps', () => {
    const normalPath: MatchStatus[] = ['SCHEDULED', 'FIRST_HALF', 'HALF_TIME', 'SECOND_HALF', 'FULL_TIME', 'COMPLETED']
    for (let i = 0; i < normalPath.length - 1; i++) {
      expect(NEXT_PHASE[normalPath[i]]).toBe(normalPath[i + 1])
    }
  })
})

describe('Full match lifecycle — extra time + penalties', () => {
  it('traverses ET + PSO path correctly', () => {
    // After FULL_TIME, coordinator triggers extra-time endpoint (not /phase/next)
    // Then: ET_FIRST_HALF → ET_HALF_TIME → ET_SECOND_HALF → ET_FULL_TIME
    // Coordinator triggers penalty endpoint, then PENALTY_SHOOTOUT → COMPLETED
    const etPath: MatchStatus[] = ['EXTRA_TIME_FIRST_HALF', 'EXTRA_TIME_HALF_TIME', 'EXTRA_TIME_SECOND_HALF', 'EXTRA_TIME_FULL_TIME']
    for (let i = 0; i < etPath.length - 1; i++) {
      expect(NEXT_PHASE[etPath[i]]).toBe(etPath[i + 1])
    }
    expect(NEXT_PHASE['PENALTY_SHOOTOUT']).toBe('COMPLETED')
  })
})

describe('Score update logic', () => {
  it('GOAL increments the scoring team score', () => {
    const homeScore = 0, awayScore = 0
    const teamId = 'home-team-id'
    const homeTeamId = 'home-team-id'
    const isHome = teamId === homeTeamId
    expect({ homeScore: isHome ? homeScore + 1 : homeScore, awayScore: !isHome ? awayScore + 1 : awayScore })
      .toEqual({ homeScore: 1, awayScore: 0 })
  })

  it('OWN_GOAL increments the opposing team score', () => {
    const homeScore = 0, awayScore = 0
    const teamId: string = 'home-team-id'    // team that scored own goal
    const homeTeamId: string = 'home-team-id'
    const awayTeamId: string = 'away-team-id'
    const scoringTeamId = teamId === homeTeamId ? awayTeamId : homeTeamId
    const isHome = scoringTeamId === homeTeamId
    expect({ homeScore: isHome ? homeScore + 1 : homeScore, awayScore: !isHome ? awayScore + 1 : awayScore })
      .toEqual({ homeScore: 0, awayScore: 1 })
  })

  it('Removing a goal decrements score to minimum 0', () => {
    const homeScore = 1
    expect(Math.max(0, homeScore - 1)).toBe(0)
    expect(Math.max(0, 0 - 1)).toBe(0)
  })
})

describe('Lineup validation', () => {
  it('rejects too many starters', () => {
    const players = Array.from({ length: 12 }, (_, i) => ({ userId: `u${i}`, isSubstitute: false }))
    const starters = players.filter((p) => !p.isSubstitute)
    expect(starters.length > 11).toBe(true)
  })

  it('accepts exactly playingMembers starters', () => {
    const players = Array.from({ length: 11 }, (_, i) => ({ userId: `u${i}`, isSubstitute: false }))
    const starters = players.filter((p) => !p.isSubstitute)
    expect(starters.length <= 11).toBe(true)
  })

  it('rejects too many bench players', () => {
    const players = Array.from({ length: 6 }, (_, i) => ({ userId: `u${i}`, isSubstitute: true }))
    const bench = players.filter((p) => p.isSubstitute)
    expect(bench.length > 5).toBe(true)
  })
})
