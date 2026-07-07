import express from 'express'
import { z } from 'zod'
import type { MatchEventType, MatchStatus } from '@prisma/client'
import { prisma } from '../lib/prisma.js'
import { requireAuth } from '../middleware/auth.js'
import { asyncHandler } from '../middleware/errorHandler.js'
import { canManageTournament } from '../services/tournaments.js'
import { hasDecisiveResult, advanceBracketOnCompletion } from '../services/knockout.js'
import { broadcastMatchEvent } from '../lib/realtime.js'

const router = express.Router()

// ---------------------------------------------------------------------------
// GET /live — all currently-live matches (must be registered before /:id)
// ---------------------------------------------------------------------------

const LIVE_STATUSES = [
  'FIRST_HALF', 'HALF_TIME', 'SECOND_HALF',
  'EXTRA_TIME_FIRST_HALF', 'EXTRA_TIME_HALF_TIME', 'EXTRA_TIME_SECOND_HALF',
  'PENALTY_SHOOTOUT',
]

router.get(
  '/live',
  requireAuth,
  asyncHandler(async (_req, res) => {
    const matches = await prisma.match.findMany({
      where: { status: { in: LIVE_STATUSES as never[] } },
      select: {
        id: true, status: true,
        homeScore: true, awayScore: true, matchTime: true,
        firstHalfStartedAt: true, halfTimeAt: true,
        secondHalfStartedAt: true, fullTimeAt: true,
        etFirstHalfStartedAt: true, etHalfTimeAt: true,
        etSecondHalfStartedAt: true, etFullTimeAt: true,
        penaltyStartedAt: true, completedAt: true,
        round: true,
        homeTeam: { select: { id: true, name: true, badgeUrl: true, homeColour: true, shortCode: true } },
        awayTeam: { select: { id: true, name: true, badgeUrl: true, homeColour: true, shortCode: true } },
        tournament: { select: { id: true, name: true } },
      },
      orderBy: { scheduledAt: 'asc' },
      take: 20,
    })

    res.json({ matches })
  })
)

// ---------------------------------------------------------------------------
// GET /upcoming — next scheduled matches across all published tournaments
// (must be registered before /:id). Backs the dashboard's "Upcoming Fixtures"
// widget, which the Next.js app queried via Prisma directly in the page.
// ---------------------------------------------------------------------------

router.get(
  '/upcoming',
  requireAuth,
  asyncHandler(async (_req, res) => {
    const matches = await prisma.match.findMany({
      where: {
        status: 'SCHEDULED',
        scheduledAt: { gte: new Date() },
        tournament: { isPublished: true, deletedAt: null },
      },
      include: {
        homeTeam: { select: { id: true, name: true } },
        awayTeam: { select: { id: true, name: true } },
        tournament: { select: { id: true, name: true } },
      },
      orderBy: { scheduledAt: 'asc' },
      take: 6,
    })

    // Excludes not-yet-scheduled knockout placeholder matches (null date/teams).
    const upcoming = matches.filter((m) => m.scheduledAt !== null && m.homeTeam !== null && m.awayTeam !== null)

    res.json({ matches: upcoming })
  })
)

// ---------------------------------------------------------------------------
// GET /:id — match details
// PATCH /:id — update match
// DELETE /:id — delete match
// ---------------------------------------------------------------------------

const updateSchema = z.object({
  scheduledAt: z.string().optional(),
  venue: z.string().optional(),
  round: z.string().optional(),
  homeTeamId: z.string().optional(),
  awayTeamId: z.string().optional(),
  homeScore: z.number().int().min(0).optional(),
  awayScore: z.number().int().min(0).optional(),
  status: z.enum([
    'SCHEDULED', 'FIRST_HALF', 'HALF_TIME', 'SECOND_HALF', 'FULL_TIME',
    'EXTRA_TIME_FIRST_HALF', 'EXTRA_TIME_HALF_TIME', 'EXTRA_TIME_SECOND_HALF',
    'EXTRA_TIME_FULL_TIME', 'PENALTY_SHOOTOUT', 'COMPLETED', 'CANCELLED', 'POSTPONED',
  ]).optional(),
})

router.get(
  '/:id',
  requireAuth,
  asyncHandler(async (req, res) => {
    const { id } = req.params

    const match = await prisma.match.findUnique({
      where: { id },
      include: {
        homeTeam: { select: { id: true, name: true, homeColour: true, badgeUrl: true, shortCode: true } },
        awayTeam: { select: { id: true, name: true, homeColour: true, badgeUrl: true, shortCode: true } },
        tournament: { select: { id: true, name: true } },
        group: { select: { id: true, name: true } },
        events: {
          include: {
            primaryUser: { select: { id: true, displayName: true } },
            secondaryUser: { select: { id: true, displayName: true } },
          },
          orderBy: { minute: 'asc' },
        },
      },
    })

    if (!match) return res.status(404).json({ error: 'Not found' })
    res.json({ match })
  })
)

router.patch(
  '/:id',
  requireAuth,
  asyncHandler(async (req, res) => {
    const user = req.user!
    const { id } = req.params

    const match = await prisma.match.findUnique({
      where: { id },
      select: {
        tournamentId: true, homeTeamId: true, awayTeamId: true,
        homeScore: true, awayScore: true, homePenaltyScore: true, awayPenaltyScore: true,
        bracketRoundSize: true, homeSourceMatchId: true, awaySourceMatchId: true,
      },
    })
    if (!match) return res.status(404).json({ error: 'Not found' })

    if (!(await canManageTournament(match.tournamentId, user.id, user.role))) {
      return res.status(403).json({ error: 'Forbidden' })
    }

    const parsed = updateSchema.safeParse(req.body)
    if (!parsed.success) return res.status(400).json({ error: 'Invalid data' })

    const d = parsed.data

    // Teams are only hand-editable on matches the system doesn't own (no source-match links,
    // i.e. round-1 knockout matches or non-bracket matches). Rounds 2+ are filled in automatically.
    if (d.homeTeamId !== undefined || d.awayTeamId !== undefined) {
      if (match.homeSourceMatchId || match.awaySourceMatchId) {
        return res.status(409).json({
          error: 'Teams for this match are set automatically from the previous round and cannot be edited',
        })
      }
      const newHome = d.homeTeamId ?? match.homeTeamId
      const newAway = d.awayTeamId ?? match.awayTeamId
      if (newHome && newAway && newHome === newAway) {
        return res.status(400).json({ error: 'Home and away teams must be different' })
      }
      const ids = [newHome, newAway].filter((v): v is string => !!v)
      if (ids.length) {
        const regs = await prisma.tournamentTeam.findMany({
          where: { tournamentId: match.tournamentId, teamId: { in: ids } },
          select: { teamId: true },
        })
        if (regs.length !== ids.length) {
          return res.status(400).json({ error: 'Team must be registered in this tournament' })
        }
      }
    }

    // Knockout matches must have a decisive result (incl. penalties) before they can complete
    if (d.status === 'COMPLETED' && match.bracketRoundSize !== null) {
      const effective = {
        homeScore: d.homeScore ?? match.homeScore,
        awayScore: d.awayScore ?? match.awayScore,
        homePenaltyScore: match.homePenaltyScore,
        awayPenaltyScore: match.awayPenaltyScore,
      }
      if (!hasDecisiveResult(effective)) {
        return res.status(409).json({
          error: 'Knockout match is level — resolve with Extra Time or a Penalty Shootout before completing it',
        })
      }
    }

    const updated = await prisma.$transaction(async (tx) => {
      const result = await tx.match.update({
        where: { id },
        data: {
          ...(d.scheduledAt ? { scheduledAt: new Date(d.scheduledAt) } : {}),
          ...(d.venue !== undefined ? { venue: d.venue } : {}),
          ...(d.round !== undefined ? { round: d.round } : {}),
          ...(d.homeTeamId !== undefined ? { homeTeamId: d.homeTeamId } : {}),
          ...(d.awayTeamId !== undefined ? { awayTeamId: d.awayTeamId } : {}),
          ...(d.homeScore !== undefined ? { homeScore: d.homeScore } : {}),
          ...(d.awayScore !== undefined ? { awayScore: d.awayScore } : {}),
          ...(d.status ? { status: d.status, ...(d.status === 'COMPLETED' ? { completedAt: new Date() } : {}) } : {}),
        },
        include: {
          homeTeam: { select: { id: true, name: true, homeColour: true, badgeUrl: true, shortCode: true } },
          awayTeam: { select: { id: true, name: true, homeColour: true, badgeUrl: true, shortCode: true } },
        },
      })
      if (d.status === 'COMPLETED') {
        await advanceBracketOnCompletion(tx, id)
      }
      return result
    })

    res.json({ match: updated })
  })
)

router.delete(
  '/:id',
  requireAuth,
  asyncHandler(async (req, res) => {
    const user = req.user!
    const { id } = req.params

    const match = await prisma.match.findUnique({
      where: { id },
      select: { tournamentId: true, status: true, bracketRoundSize: true, homeSourceMatchId: true, awaySourceMatchId: true },
    })
    if (!match) return res.status(404).json({ error: 'Not found' })

    if (!(await canManageTournament(match.tournamentId, user.id, user.role))) {
      return res.status(403).json({ error: 'Forbidden' })
    }
    if (match.status !== 'SCHEDULED' && match.status !== 'POSTPONED' && match.status !== 'CANCELLED') {
      return res.status(409).json({ error: 'Cannot delete a match that has started' })
    }
    if (match.bracketRoundSize !== null) {
      if (match.homeSourceMatchId || match.awaySourceMatchId) {
        return res.status(409).json({ error: 'Cannot delete a system-generated knockout round match' })
      }
      const referencedByOther = await prisma.match.findFirst({
        where: { OR: [{ homeSourceMatchId: id }, { awaySourceMatchId: id }] },
        select: { id: true },
      })
      if (referencedByOther) {
        return res.status(409).json({ error: 'Cannot delete this match — later rounds of the bracket already reference it' })
      }
    }

    await prisma.match.delete({ where: { id } })
    res.json({ success: true })
  })
)

// ---------------------------------------------------------------------------
// GET /:id/lineup — list lineups
// POST /:id/lineup — set (upsert) a team's lineup for the match
// ---------------------------------------------------------------------------

const lineupPlayerSchema = z.object({
  userId: z.string(),
  jerseyNumber: z.number().int().min(1).max(99),
  position: z.enum(['GK', 'DEF', 'MID', 'FWD']),
  isSubstitute: z.boolean(),
})

const lineupSchema = z.object({
  teamId: z.string(),
  players: z.array(lineupPlayerSchema).min(1),
})

router.get(
  '/:id/lineup',
  requireAuth,
  asyncHandler(async (req, res) => {
    const { id } = req.params

    const lineups = await prisma.matchLineup.findMany({
      where: { matchId: id },
      include: {
        user: { select: { id: true, displayName: true, avatarUrl: true } },
        team: { select: { id: true, name: true } },
      },
      orderBy: [{ teamId: 'asc' }, { isSubstitute: 'asc' }, { jerseyNumber: 'asc' }],
    })

    res.json({ lineups })
  })
)

router.post(
  '/:id/lineup',
  requireAuth,
  asyncHandler(async (req, res) => {
    const user = req.user!
    const { id } = req.params

    const match = await prisma.match.findUnique({
      where: { id },
      select: { tournamentId: true, homeTeamId: true, awayTeamId: true, playingMembers: true, maxSubstitutes: true, status: true },
    })
    if (!match) return res.status(404).json({ error: 'Match not found' })
    if (!(await canManageTournament(match.tournamentId, user.id, user.role))) {
      return res.status(403).json({ error: 'Forbidden' })
    }

    const completedStatuses = ['COMPLETED', 'CANCELLED']
    if (completedStatuses.includes(match.status)) {
      return res.status(409).json({ error: 'Cannot update lineup for a completed match' })
    }

    const parsed = lineupSchema.safeParse(req.body)
    if (!parsed.success) return res.status(400).json({ error: 'Invalid data', issues: parsed.error.issues })

    const { teamId, players } = parsed.data
    if (teamId !== match.homeTeamId && teamId !== match.awayTeamId) {
      return res.status(400).json({ error: 'Team is not in this match' })
    }

    const starters = players.filter((p) => !p.isSubstitute)
    const bench = players.filter((p) => p.isSubstitute)

    if (starters.length > match.playingMembers) {
      return res.status(400).json({ error: `Too many starters. Max: ${match.playingMembers}` })
    }
    if (bench.length > match.maxSubstitutes) {
      return res.status(400).json({ error: `Too many bench players. Max: ${match.maxSubstitutes}` })
    }

    // Upsert: delete existing lineup for this team in this match, then re-create
    await prisma.matchLineup.deleteMany({ where: { matchId: id, teamId } })
    await prisma.matchLineup.createMany({
      data: players.map((p) => ({
        matchId: id,
        teamId,
        userId: p.userId,
        jerseyNumber: p.jerseyNumber,
        position: p.position,
        isSubstitute: p.isSubstitute,
      })),
    })

    res.json({ success: true })
  })
)

// ---------------------------------------------------------------------------
// GET /:id/events — list match events
// POST /:id/events — log a match event (updates score on goal events)
// ---------------------------------------------------------------------------

const ACTIVE_PHASES = ['FIRST_HALF', 'SECOND_HALF', 'EXTRA_TIME_FIRST_HALF', 'EXTRA_TIME_SECOND_HALF']

const eventSchema = z.object({
  type: z.enum(['GOAL', 'OWN_GOAL', 'EXTRA_TIME_GOAL', 'YELLOW_CARD', 'RED_CARD', 'SECOND_YELLOW', 'SUBSTITUTION']),
  minute: z.number().int().min(0).max(200),
  teamId: z.string(),
  primaryUserId: z.string().optional(),
  secondaryUserId: z.string().optional(),
  notes: z.string().optional(),
})

router.get(
  '/:id/events',
  requireAuth,
  asyncHandler(async (req, res) => {
    const { id } = req.params

    const events = await prisma.matchEvent.findMany({
      where: { matchId: id },
      include: {
        primaryUser: { select: { id: true, displayName: true } },
        secondaryUser: { select: { id: true, displayName: true } },
        team: { select: { id: true, name: true } },
      },
      orderBy: { minute: 'asc' },
    })

    res.json({ events })
  })
)

router.post(
  '/:id/events',
  requireAuth,
  asyncHandler(async (req, res) => {
    const user = req.user!
    const { id } = req.params

    const match = await prisma.match.findUnique({
      where: { id },
      select: { tournamentId: true, homeTeamId: true, awayTeamId: true, status: true },
    })
    if (!match) return res.status(404).json({ error: 'Match not found' })
    if (!(await canManageTournament(match.tournamentId, user.id, user.role))) {
      return res.status(403).json({ error: 'Forbidden' })
    }
    if (!ACTIVE_PHASES.includes(match.status)) {
      return res.status(409).json({ error: 'Events can only be logged during active match phases' })
    }

    const parsed = eventSchema.safeParse(req.body)
    if (!parsed.success) return res.status(400).json({ error: 'Invalid data', issues: parsed.error.issues })

    const d = parsed.data
    if (d.teamId !== match.homeTeamId && d.teamId !== match.awayTeamId) {
      return res.status(400).json({ error: 'Team is not in this match' })
    }

    // Update score on GOAL / OWN_GOAL / EXTRA_TIME_GOAL
    const isGoalEvent = ['GOAL', 'OWN_GOAL', 'EXTRA_TIME_GOAL'].includes(d.type)
    const event = await prisma.$transaction(async (tx) => {
      const newEvent = await tx.matchEvent.create({
        data: {
          matchId: id,
          type: d.type,
          minute: d.minute,
          teamId: d.teamId,
          primaryUserId: d.primaryUserId ?? null,
          secondaryUserId: d.secondaryUserId ?? null,
          notes: d.notes ?? null,
          createdById: user.id,
        },
        include: {
          primaryUser: { select: { id: true, displayName: true } },
          secondaryUser: { select: { id: true, displayName: true } },
          team: { select: { id: true, name: true } },
        },
      })

      if (isGoalEvent) {
        const current = await tx.match.findUnique({ where: { id }, select: { homeScore: true, awayScore: true, homeTeamId: true } })
        if (current) {
          // OWN_GOAL scores for the OPPOSING team
          const isOwnGoal = d.type === 'OWN_GOAL'
          const scoringTeamId = isOwnGoal
            ? (d.teamId === current.homeTeamId ? match.awayTeamId : current.homeTeamId)
            : d.teamId
          const isHome = scoringTeamId === current.homeTeamId
          await tx.match.update({
            where: { id },
            data: {
              homeScore: isHome ? current.homeScore + 1 : current.homeScore,
              awayScore: !isHome ? current.awayScore + 1 : current.awayScore,
            },
          })
        }
      }

      return newEvent
    })

    res.status(201).json({ event })
  })
)

// ---------------------------------------------------------------------------
// PATCH /:id/events/:eventId — edit a match event (recalculates score if needed)
// DELETE /:id/events/:eventId — delete a match event (recalculates score if needed)
// ---------------------------------------------------------------------------

const GOAL_TYPES: MatchEventType[] = ['GOAL', 'OWN_GOAL', 'EXTRA_TIME_GOAL']

const eventPatchSchema = z.object({
  type: z.enum(['GOAL', 'OWN_GOAL', 'EXTRA_TIME_GOAL', 'YELLOW_CARD', 'RED_CARD', 'SECOND_YELLOW', 'SUBSTITUTION']),
  minute: z.number().int().min(0).max(200),
  teamId: z.string(),
  primaryUserId: z.string().nullable().optional(),
  secondaryUserId: z.string().nullable().optional(),
})

/** Recalculate homeScore/awayScore from all goal events (called after any edit/delete). */
async function recalcScore(tx: Parameters<Parameters<typeof prisma.$transaction>[0]>[0], matchId: string, homeTeamId: string, awayTeamId: string) {
  const goals = await tx.matchEvent.findMany({
    where: { matchId, type: { in: GOAL_TYPES } },
    select: { type: true, teamId: true },
  })
  let homeScore = 0, awayScore = 0
  for (const g of goals) {
    const scoringTeam = g.type === 'OWN_GOAL'
      ? (g.teamId === homeTeamId ? awayTeamId : homeTeamId)
      : g.teamId
    if (scoringTeam === homeTeamId) homeScore++
    else awayScore++
  }
  await tx.match.update({ where: { id: matchId }, data: { homeScore, awayScore } })
}

router.patch(
  '/:id/events/:eventId',
  requireAuth,
  asyncHandler(async (req, res) => {
    const user = req.user!
    const { id, eventId } = req.params

    const match = await prisma.match.findUnique({
      where: { id },
      select: { tournamentId: true, homeTeamId: true, awayTeamId: true },
    })
    if (!match) return res.status(404).json({ error: 'Match not found' })
    if (!(await canManageTournament(match.tournamentId, user.id, user.role))) {
      return res.status(403).json({ error: 'Forbidden' })
    }
    if (!match.homeTeamId || !match.awayTeamId) {
      return res.status(409).json({ error: 'Match has no teams assigned yet' })
    }
    const homeTeamId = match.homeTeamId
    const awayTeamId = match.awayTeamId

    const parsed = eventPatchSchema.safeParse(req.body)
    if (!parsed.success) return res.status(400).json({ error: 'Invalid data', issues: parsed.error.issues })

    const d = parsed.data
    const oldType = (await prisma.matchEvent.findUnique({ where: { id: eventId }, select: { type: true } }))?.type
    if (!oldType) return res.status(404).json({ error: 'Event not found' })

    const needsRecalc = GOAL_TYPES.includes(oldType) || GOAL_TYPES.includes(d.type)

    const updated = await prisma.$transaction(async (tx) => {
      const evt = await tx.matchEvent.update({
        where: { id: eventId },
        data: {
          type:            d.type,
          minute:          d.minute,
          teamId:          d.teamId,
          primaryUserId:   d.primaryUserId ?? null,
          secondaryUserId: d.secondaryUserId ?? null,
        },
        include: {
          primaryUser:   { select: { id: true, displayName: true } },
          secondaryUser: { select: { id: true, displayName: true } },
          team:          { select: { id: true, name: true } },
        },
      })
      if (needsRecalc) await recalcScore(tx, id, homeTeamId, awayTeamId)
      return evt
    })

    res.json({ event: updated })
  })
)

router.delete(
  '/:id/events/:eventId',
  requireAuth,
  asyncHandler(async (req, res) => {
    const user = req.user!
    const { id, eventId } = req.params

    const match = await prisma.match.findUnique({
      where: { id },
      select: { tournamentId: true, homeTeamId: true, awayTeamId: true },
    })
    if (!match) return res.status(404).json({ error: 'Match not found' })
    if (!(await canManageTournament(match.tournamentId, user.id, user.role))) {
      return res.status(403).json({ error: 'Forbidden' })
    }
    if (!match.homeTeamId || !match.awayTeamId) {
      return res.status(409).json({ error: 'Match has no teams assigned yet' })
    }
    const homeTeamId = match.homeTeamId
    const awayTeamId = match.awayTeamId

    const event = await prisma.matchEvent.findUnique({
      where: { id: eventId },
      select: { id: true, type: true, teamId: true },
    })
    if (!event) return res.status(404).json({ error: 'Event not found' })

    const needsRecalc = GOAL_TYPES.includes(event.type)
    await prisma.$transaction(async (tx) => {
      await tx.matchEvent.delete({ where: { id: eventId } })
      if (needsRecalc) await recalcScore(tx, id, homeTeamId, awayTeamId)
    })

    res.json({ success: true })
  })
)

// ---------------------------------------------------------------------------
// GET /:id/penalties — list penalty shootout kicks
// POST /:id/penalties — log a penalty kick (updates penalty score totals)
// ---------------------------------------------------------------------------

const penaltySchema = z.object({
  teamId: z.string(),
  userId: z.string().optional(),
  kickOrder: z.number().int().min(1),
  scored: z.boolean(),
})

router.get(
  '/:id/penalties',
  requireAuth,
  asyncHandler(async (req, res) => {
    const { id } = req.params

    const penalties = await prisma.penaltyShootout.findMany({
      where: { matchId: id },
      include: {
        user: { select: { id: true, displayName: true } },
        team: { select: { id: true, name: true } },
      },
      orderBy: [{ teamId: 'asc' }, { kickOrder: 'asc' }],
    })

    res.json({ penalties })
  })
)

router.post(
  '/:id/penalties',
  requireAuth,
  asyncHandler(async (req, res) => {
    const user = req.user!
    const { id } = req.params

    const match = await prisma.match.findUnique({
      where: { id },
      select: { tournamentId: true, homeTeamId: true, awayTeamId: true, status: true },
    })
    if (!match) return res.status(404).json({ error: 'Match not found' })
    if (!(await canManageTournament(match.tournamentId, user.id, user.role))) {
      return res.status(403).json({ error: 'Forbidden' })
    }
    if (match.status !== 'PENALTY_SHOOTOUT') {
      return res.status(409).json({ error: 'Penalty kicks can only be logged during PENALTY_SHOOTOUT phase' })
    }

    const parsed = penaltySchema.safeParse(req.body)
    if (!parsed.success) return res.status(400).json({ error: 'Invalid data', issues: parsed.error.issues })

    const d = parsed.data
    if (d.teamId !== match.homeTeamId && d.teamId !== match.awayTeamId) {
      return res.status(400).json({ error: 'Team is not in this match' })
    }

    const penalty = await prisma.$transaction(async (tx) => {
      const kick = await tx.penaltyShootout.create({
        data: {
          matchId: id,
          teamId: d.teamId,
          userId: d.userId ?? null,
          kickOrder: d.kickOrder,
          scored: d.scored,
          createdById: user.id,
        },
        include: {
          user: { select: { id: true, displayName: true } },
          team: { select: { id: true, name: true } },
        },
      })

      // Update penalty score totals
      const allKicks = await tx.penaltyShootout.findMany({
        where: { matchId: id },
        select: { teamId: true, scored: true },
      })
      const homeGoals = allKicks.filter((k) => k.teamId === match.homeTeamId && k.scored).length
      const awayGoals = allKicks.filter((k) => k.teamId === match.awayTeamId && k.scored).length
      await tx.match.update({
        where: { id },
        data: { homePenaltyScore: homeGoals, awayPenaltyScore: awayGoals },
      })

      return kick
    })

    res.status(201).json({ penalty })
  })
)

// ---------------------------------------------------------------------------
// DELETE /:id/penalties/:kickId — delete a penalty kick (recalculates penalty score)
// ---------------------------------------------------------------------------

router.delete(
  '/:id/penalties/:kickId',
  requireAuth,
  asyncHandler(async (req, res) => {
    const user = req.user!
    const { id, kickId } = req.params

    const match = await prisma.match.findUnique({
      where: { id },
      select: { tournamentId: true, homeTeamId: true, awayTeamId: true },
    })
    if (!match) return res.status(404).json({ error: 'Match not found' })
    if (!(await canManageTournament(match.tournamentId, user.id, user.role))) {
      return res.status(403).json({ error: 'Forbidden' })
    }

    const kick = await prisma.penaltyShootout.findUnique({ where: { id: kickId }, select: { id: true } })
    if (!kick) return res.status(404).json({ error: 'Penalty kick not found' })

    await prisma.$transaction(async (tx) => {
      await tx.penaltyShootout.delete({ where: { id: kickId } })
      // Recalculate penalty scores
      const remaining = await tx.penaltyShootout.findMany({
        where: { matchId: id },
        select: { teamId: true, scored: true },
      })
      const homeGoals = remaining.filter((k) => k.teamId === match.homeTeamId && k.scored).length
      const awayGoals = remaining.filter((k) => k.teamId === match.awayTeamId && k.scored).length
      await tx.match.update({
        where: { id },
        data: { homePenaltyScore: homeGoals, awayPenaltyScore: awayGoals },
      })
    })

    res.json({ success: true })
  })
)

// ---------------------------------------------------------------------------
// POST /:id/phase/next — advance the match to the next phase in the state machine
// ---------------------------------------------------------------------------

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

function getTimestampField(status: MatchStatus): string | null {
  const map: Partial<Record<MatchStatus, string>> = {
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
  return map[status] ?? null
}

router.post(
  '/:id/phase/next',
  requireAuth,
  asyncHandler(async (req, res) => {
    const user = req.user!
    const { id } = req.params

    const match = await prisma.match.findUnique({
      where: { id },
      select: {
        tournamentId: true, status: true, homeTeamId: true, awayTeamId: true, playingMembers: true,
        bracketRoundSize: true, homeScore: true, awayScore: true, homePenaltyScore: true, awayPenaltyScore: true,
      },
    })
    if (!match) return res.status(404).json({ error: 'Match not found' })
    if (!(await canManageTournament(match.tournamentId, user.id, user.role))) {
      return res.status(403).json({ error: 'Forbidden' })
    }

    // Gate: tournament must be ONGOING before kick-off
    if (match.status === 'SCHEDULED') {
      const tournament = await prisma.tournament.findUnique({
        where: { id: match.tournamentId },
        select: { status: true },
      })
      if (!tournament || tournament.status !== 'ONGOING') {
        return res.status(409).json({ error: 'Tournament must be in Ongoing status before starting a match' })
      }
    }

    // Gate: both teams must have a full starting lineup before kick-off
    if (match.status === 'SCHEDULED') {
      const lineupCounts = await prisma.matchLineup.groupBy({
        by: ['teamId'],
        where: { matchId: id, isSubstitute: false },
        _count: { _all: true },
      })
      const homeCount = lineupCounts.find((r) => r.teamId === match.homeTeamId)?._count._all ?? 0
      const awayCount = lineupCounts.find((r) => r.teamId === match.awayTeamId)?._count._all ?? 0
      if (homeCount < match.playingMembers || awayCount < match.playingMembers) {
        return res.status(409).json({
          error: `Set lineups for both teams before starting (home: ${homeCount}/${match.playingMembers}, away: ${awayCount}/${match.playingMembers})`,
        })
      }
    }

    const nextStatus = NEXT_PHASE[match.status]
    if (!nextStatus) {
      return res.status(400).json({ error: `No next phase from ${match.status}` })
    }

    if (nextStatus === 'COMPLETED' && match.bracketRoundSize !== null && !hasDecisiveResult(match)) {
      return res.status(409).json({
        error: 'Knockout match is level — resolve with Extra Time or a Penalty Shootout before completing it',
      })
    }

    const tsField = getTimestampField(nextStatus)
    const now = new Date()

    const updated = await prisma.$transaction(async (tx) => {
      const result = await tx.match.update({
        where: { id },
        data: {
          status: nextStatus,
          ...(tsField ? { [tsField]: now } : {}),
        },
        select: { id: true, status: true, [tsField ?? 'id']: true },
      })
      if (nextStatus === 'COMPLETED') {
        await advanceBracketOnCompletion(tx, id)
      }
      return result
    })

    // Broadcast phase change for instant client updates (supplements postgres_changes)
    void broadcastMatchEvent(id, 'PHASE_CHANGE', {
      matchId: id,
      status: nextStatus,
      timestamp: now.toISOString(),
    })

    res.json({ match: updated })
  })
)

// ---------------------------------------------------------------------------
// POST /:id/phase/extra-time — trigger extra time after Full Time
// ---------------------------------------------------------------------------

router.post(
  '/:id/phase/extra-time',
  requireAuth,
  asyncHandler(async (req, res) => {
    const user = req.user!
    const { id } = req.params

    const match = await prisma.match.findUnique({
      where: { id },
      select: { tournamentId: true, status: true },
    })
    if (!match) return res.status(404).json({ error: 'Match not found' })
    if (!(await canManageTournament(match.tournamentId, user.id, user.role))) {
      return res.status(403).json({ error: 'Forbidden' })
    }
    if (match.status !== 'FULL_TIME') {
      return res.status(400).json({ error: 'Extra time can only be triggered after Full Time' })
    }

    const now = new Date()
    const updated = await prisma.match.update({
      where: { id },
      data: { status: 'EXTRA_TIME_FIRST_HALF', etFirstHalfStartedAt: now },
      select: { id: true, status: true },
    })

    void broadcastMatchEvent(id, 'PHASE_CHANGE', { matchId: id, status: 'EXTRA_TIME_FIRST_HALF', timestamp: now.toISOString() })

    res.json({ match: updated })
  })
)

// ---------------------------------------------------------------------------
// POST /:id/phase/penalties — trigger penalty shootout after Full Time / ET Full Time
// ---------------------------------------------------------------------------

router.post(
  '/:id/phase/penalties',
  requireAuth,
  asyncHandler(async (req, res) => {
    const user = req.user!
    const { id } = req.params

    const match = await prisma.match.findUnique({
      where: { id },
      select: { tournamentId: true, status: true },
    })
    if (!match) return res.status(404).json({ error: 'Match not found' })
    if (!(await canManageTournament(match.tournamentId, user.id, user.role))) {
      return res.status(403).json({ error: 'Forbidden' })
    }
    if (match.status !== 'FULL_TIME' && match.status !== 'EXTRA_TIME_FULL_TIME') {
      return res.status(400).json({ error: 'Penalties can only be triggered after Full Time or Extra Time Full Time' })
    }

    const now = new Date()
    const updated = await prisma.match.update({
      where: { id },
      data: { status: 'PENALTY_SHOOTOUT', penaltyStartedAt: now },
      select: { id: true, status: true },
    })

    void broadcastMatchEvent(id, 'PHASE_CHANGE', { matchId: id, status: 'PENALTY_SHOOTOUT', timestamp: now.toISOString() })

    res.json({ match: updated })
  })
)

// ---------------------------------------------------------------------------
// POST /:id/player-of-match — set (or clear) the match's player of the match
// ---------------------------------------------------------------------------

router.post(
  '/:id/player-of-match',
  requireAuth,
  asyncHandler(async (req, res) => {
    const user = req.user!
    const { id } = req.params

    const match = await prisma.match.findUnique({
      where: { id },
      select: { tournamentId: true, status: true },
    })
    if (!match) return res.status(404).json({ error: 'Match not found' })
    if (!(await canManageTournament(match.tournamentId, user.id, user.role))) {
      return res.status(403).json({ error: 'Forbidden' })
    }

    const { playerOfMatchId } = req.body

    const updated = await prisma.match.update({
      where: { id },
      data: { playerOfMatchId: playerOfMatchId ?? null },
      select: { id: true, playerOfMatchId: true },
    })

    res.json({ match: updated })
  })
)

export const matchesRouter = router
