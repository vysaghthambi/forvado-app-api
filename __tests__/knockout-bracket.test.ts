import { describe, it, expect } from 'vitest'
import type { Prisma } from '@prisma/client'
import {
  roundLabel,
  isPowerOfTwo,
  hasDecisiveResult,
  getMatchWinnerTeamId,
  generateBracketSkeleton,
  maybeGenerateBracketSkeleton,
  advanceBracketOnCompletion,
} from '../src/services/knockout.js'

// ─── Minimal in-memory Prisma.TransactionClient mock ──────────────────────────
// Covers only the query shapes services/knockout.ts actually issues.

function matchesWhere(row: Record<string, unknown>, where: Record<string, unknown>): boolean {
  return Object.entries(where).every(([k, v]) => row[k] === v)
}

function sortByField<T extends Record<string, unknown>>(rows: T[], field: string, dir: 'asc' | 'desc'): T[] {
  const sorted = [...rows].sort((a, b) => ((a[field] as number) ?? 0) - ((b[field] as number) ?? 0))
  return dir === 'desc' ? sorted.reverse() : sorted
}

function project<T extends Record<string, unknown>>(row: T, select?: Record<string, boolean>) {
  if (!select) return row
  const out: Record<string, unknown> = {}
  for (const k of Object.keys(select)) out[k] = row[k]
  return out
}

type Row = Record<string, unknown>
type QueryArgs = { where?: Row; orderBy?: Record<string, 'asc' | 'desc'>; select?: Record<string, boolean>; data?: Row }

function createMockTx(seed: Row[] = []) {
  const matches: Row[] = seed.map((m) => ({ ...m }))
  let counter = matches.length

  return {
    match: {
      findFirst: async ({ where = {}, orderBy, select }: QueryArgs) => {
        let rows = matches.filter((m) => matchesWhere(m, where))
        if (orderBy) {
          const [field, dir] = Object.entries(orderBy)[0]
          rows = sortByField(rows, field, dir)
        }
        return rows[0] ? project(rows[0], select) : null
      },
      findMany: async ({ where = {}, orderBy, select }: QueryArgs) => {
        let rows = matches.filter((m) => matchesWhere(m, where))
        if (orderBy) {
          const [field, dir] = Object.entries(orderBy)[0]
          rows = sortByField(rows, field, dir)
        }
        return rows.map((m) => project(m, select))
      },
      findUnique: async ({ where = {}, select }: QueryArgs) => {
        const row = matches.find((m) => m.id === where.id)
        return row ? project(row, select) : null
      },
      count: async ({ where = {} }: QueryArgs) => matches.filter((m) => matchesWhere(m, where)).length,
      create: async ({ data = {}, select }: QueryArgs) => {
        const row = { id: `m${++counter}`, ...data }
        matches.push(row)
        return project(row, select)
      },
      update: async ({ where = {}, data = {} }: QueryArgs) => {
        const row = matches.find((m) => m.id === where.id)
        Object.assign(row!, data)
        return row
      },
    },
    _all: () => matches,
  }
}

// Mock satisfies the query shapes knockout.ts uses; cast to the real tx type at call sites.
function asTx(tx: ReturnType<typeof createMockTx>): Prisma.TransactionClient {
  return tx as unknown as Prisma.TransactionClient
}

const DEFAULTS = { matchTime: 90, playingMembers: 11, maxSubstitutes: 5, venue: 'Main Ground' }

// ─── Pure helpers ──────────────────────────────────────────────────────────────

describe('isPowerOfTwo', () => {
  it('accepts powers of two', () => {
    for (const n of [1, 2, 4, 8, 16, 32, 64]) expect(isPowerOfTwo(n)).toBe(true)
  })
  it('rejects non powers of two', () => {
    for (const n of [0, -1, 3, 5, 6, 10, 100]) expect(isPowerOfTwo(n)).toBe(false)
  })
})

describe('roundLabel', () => {
  it('maps known round sizes', () => {
    expect(roundLabel(1)).toBe('FINAL')
    expect(roundLabel(2)).toBe('SEMI-FINAL')
    expect(roundLabel(4)).toBe('QUARTER FINAL')
    expect(roundLabel(8)).toBe('PRE-QUARTER FINAL')
    expect(roundLabel(16)).toBe('ROUND OF 32')
    expect(roundLabel(32)).toBe('ROUND OF 64')
    expect(roundLabel(64)).toBe('ROUND OF 128')
  })
  it('falls back to a generic label for unknown sizes', () => {
    expect(roundLabel(128)).toBe('ROUND OF 256')
  })
})

describe('hasDecisiveResult', () => {
  it('is decisive when scores differ', () => {
    expect(hasDecisiveResult({ homeScore: 2, awayScore: 1, homePenaltyScore: null, awayPenaltyScore: null })).toBe(true)
  })
  it('is not decisive when level with no penalties', () => {
    expect(hasDecisiveResult({ homeScore: 1, awayScore: 1, homePenaltyScore: null, awayPenaltyScore: null })).toBe(false)
  })
  it('is decisive when level but penalties differ', () => {
    expect(hasDecisiveResult({ homeScore: 1, awayScore: 1, homePenaltyScore: 4, awayPenaltyScore: 3 })).toBe(true)
  })
  it('is not decisive when level and penalties also tie', () => {
    expect(hasDecisiveResult({ homeScore: 1, awayScore: 1, homePenaltyScore: 2, awayPenaltyScore: 2 })).toBe(false)
  })
})

describe('getMatchWinnerTeamId', () => {
  const base = { status: 'COMPLETED', homeTeamId: 'home', awayTeamId: 'away', homePenaltyScore: null, awayPenaltyScore: null }

  it('returns null when not completed', () => {
    expect(getMatchWinnerTeamId({ ...base, status: 'FULL_TIME', homeScore: 2, awayScore: 0 })).toBeNull()
  })
  it('returns the higher-scoring team', () => {
    expect(getMatchWinnerTeamId({ ...base, homeScore: 0, awayScore: 3 })).toBe('away')
  })
  it('falls back to penalties on a level score', () => {
    expect(getMatchWinnerTeamId({ ...base, homeScore: 1, awayScore: 1, homePenaltyScore: 5, awayPenaltyScore: 4 })).toBe('home')
  })
  it('returns null on an unresolved draw', () => {
    expect(getMatchWinnerTeamId({ ...base, homeScore: 1, awayScore: 1 })).toBeNull()
  })
  it('returns null when a team is missing (TBD match)', () => {
    expect(getMatchWinnerTeamId({ ...base, homeTeamId: null, homeScore: 2, awayScore: 0 })).toBeNull()
  })
})

// ─── Bracket generation ─────────────────────────────────────────────────────────

describe('generateBracketSkeleton', () => {
  it('builds every round down to the Final and wires source matches', async () => {
    const round1 = [1, 2, 3, 4].map((slot) => ({
      id: `r1-${slot}`, tournamentId: 't1', matchOrder: slot, bracketRoundSize: 4, bracketSlot: slot,
      homeSourceMatchId: null, awaySourceMatchId: null,
    }))
    const tx = createMockTx(round1)

    await generateBracketSkeleton(asTx(tx), 't1', 4, DEFAULTS)

    const all = tx._all()
    const semis = all.filter((m) => m.bracketRoundSize === 2)
      .sort((a, b) => (a.bracketSlot as number) - (b.bracketSlot as number))
    const final = all.filter((m) => m.bracketRoundSize === 1)

    expect(semis).toHaveLength(2)
    expect(final).toHaveLength(1)
    expect(semis[0].round).toBe('SEMI-FINAL')
    expect(final[0].round).toBe('FINAL')

    // Slot 1&2 of round-1 feed semi slot 1; slot 3&4 feed semi slot 2
    expect(semis[0].homeSourceMatchId).toBe('r1-1')
    expect(semis[0].awaySourceMatchId).toBe('r1-2')
    expect(semis[1].homeSourceMatchId).toBe('r1-3')
    expect(semis[1].awaySourceMatchId).toBe('r1-4')

    // Both semis feed the Final
    expect([final[0].homeSourceMatchId, final[0].awaySourceMatchId].sort()).toEqual(
      [semis[0].id, semis[1].id].sort(),
    )

    // matchOrder continues after the existing round-1 matches, no collisions
    const orders = all.map((m) => m.matchOrder)
    expect(new Set(orders).size).toBe(orders.length)
  })
})

describe('maybeGenerateBracketSkeleton', () => {
  it('does nothing until round 1 is fully populated', async () => {
    const round1 = [1, 2].map((slot) => ({
      id: `r1-${slot}`, tournamentId: 't1', matchOrder: slot, bracketRoundSize: 4, bracketSlot: slot,
      homeSourceMatchId: null, awaySourceMatchId: null,
    }))
    const tx = createMockTx(round1)
    await maybeGenerateBracketSkeleton(asTx(tx), 't1', 4, DEFAULTS)
    expect(tx._all()).toHaveLength(2) // still just the 2 round-1 matches
  })

  it('generates the rest of the bracket once round 1 is full', async () => {
    const round1 = [1, 2, 3, 4].map((slot) => ({
      id: `r1-${slot}`, tournamentId: 't1', matchOrder: slot, bracketRoundSize: 4, bracketSlot: slot,
      homeSourceMatchId: null, awaySourceMatchId: null,
    }))
    const tx = createMockTx(round1)
    await maybeGenerateBracketSkeleton(asTx(tx), 't1', 4, DEFAULTS)
    expect(tx._all()).toHaveLength(7) // 4 + 2 semis + 1 final
  })
})

// ─── Advancing winners ───────────────────────────────────────────────────────────

describe('advanceBracketOnCompletion', () => {
  function seedPair() {
    return [
      {
        id: 'r1-1', tournamentId: 't1', bracketRoundSize: 4, bracketSlot: 1,
        homeTeamId: 'A', awayTeamId: 'B', homeScore: 2, awayScore: 1,
        homePenaltyScore: null, awayPenaltyScore: null, status: 'COMPLETED',
        homeSourceMatchId: null, awaySourceMatchId: null,
      },
      {
        id: 'semi-1', tournamentId: 't1', bracketRoundSize: 2, bracketSlot: 1,
        homeTeamId: null, awayTeamId: null, homeScore: 0, awayScore: 0,
        homePenaltyScore: null, awayPenaltyScore: null, status: 'SCHEDULED',
        homeSourceMatchId: 'r1-1', awaySourceMatchId: 'r1-2',
      },
    ]
  }

  it('fills the winner into the next match’s home slot', async () => {
    const tx = createMockTx(seedPair())
    await advanceBracketOnCompletion(asTx(tx), 'r1-1')
    const semi = tx._all().find((m) => m.id === 'semi-1')!
    expect(semi.homeTeamId).toBe('A')
    expect(semi.awayTeamId).toBeNull()
  })

  it('fills the away slot when the completed match is the away source', async () => {
    const seed = seedPair()
    // Make r1-1 the awaySource instead of homeSource of semi-1
    seed[1].awaySourceMatchId = 'r1-1'
    seed[1].homeSourceMatchId = 'other'
    const tx = createMockTx(seed)
    await advanceBracketOnCompletion(asTx(tx), 'r1-1')
    const semi = tx._all().find((m) => m.id === 'semi-1')!
    expect(semi.awayTeamId).toBe('A')
  })

  it('is a no-op for a non-bracket match', async () => {
    const tx = createMockTx([
      { id: 'g1', tournamentId: 't1', bracketRoundSize: null, homeTeamId: 'A', awayTeamId: 'B', homeScore: 1, awayScore: 0, homePenaltyScore: null, awayPenaltyScore: null, status: 'COMPLETED' },
    ])
    await expect(advanceBracketOnCompletion(asTx(tx), 'g1')).resolves.toBeUndefined()
  })

  it('is a no-op when the result is not decisive', async () => {
    const seed = seedPair()
    seed[0].homeScore = 1
    seed[0].awayScore = 1
    const tx = createMockTx(seed)
    await advanceBracketOnCompletion(asTx(tx), 'r1-1')
    const semi = tx._all().find((m) => m.id === 'semi-1')!
    expect(semi.homeTeamId).toBeNull()
  })
})
