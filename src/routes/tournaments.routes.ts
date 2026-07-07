import { Router } from 'express'
import { z } from 'zod'
import type { TournamentFormat, TournamentStatus } from '@prisma/client'
import { prisma } from '../lib/prisma.js'
import { requireAuth, requireAdmin, requireTeamOwner } from '../middleware/auth.js'
import { asyncHandler } from '../middleware/errorHandler.js'
import { canManageTournament, getTournamentWithDetails } from '../services/tournaments.js'
import { calculateStandings, calculateGroupStandings } from '../services/standings.js'
import { roundLabel, isPowerOfTwo, maybeGenerateBracketSkeleton } from '../services/knockout.js'
import { createNotification } from '../services/notifications.js'

const router = Router()

// ─────────────────────────────────────────────────────────────────────────
// GET / — list tournaments (published only, unless ADMIN)
// POST / — create tournament (ADMIN only)
// ─────────────────────────────────────────────────────────────────────────

const createSchema = z.object({
  name: z.string().min(2).max(100),
  description: z.string().optional(),
  format: z.enum(['LEAGUE', 'KNOCKOUT', 'GROUP_KNOCKOUT']),
  startDate: z.string(),
  endDate: z.string(),
  venue: z.string().optional(),
  maxTeams: z.string(),
  matchTime: z.string().optional(),
  playingMembers: z.string().optional(),
  maxSubstitutes: z.string().optional(),
  teamIds: z.array(z.string()).optional(),
})

router.get(
  '/',
  requireAuth,
  asyncHandler(async (req, res) => {
    const user = req.user!

    const status = (req.query.status as string | undefined) ?? undefined
    const format = (req.query.format as string | undefined) ?? undefined
    const search = (req.query.q as string | undefined) ?? undefined

    const tournaments = await prisma.tournament.findMany({
      where: {
        deletedAt: null,
        isPublished: user.role === 'ADMIN' ? undefined : true,
        ...(status ? { status: status as TournamentStatus } : {}),
        ...(format ? { format: format as TournamentFormat } : {}),
        ...(search ? { name: { contains: search, mode: 'insensitive' as const } } : {}),
      },
      include: {
        createdBy: { select: { id: true, displayName: true } },
        _count: { select: { teams: true, matches: true } },
      },
      orderBy: { startDate: 'asc' },
    })

    res.json({ tournaments })
  })
)

router.post(
  '/',
  requireAuth,
  requireAdmin,
  asyncHandler(async (req, res) => {
    const user = req.user!

    const parsed = createSchema.safeParse(req.body)
    if (!parsed.success) return res.status(400).json({ error: 'Invalid data', issues: parsed.error.issues })

    const d = parsed.data
    const maxTeamsInt = parseInt(d.maxTeams)

    if (d.teamIds && d.teamIds.length !== maxTeamsInt) {
      return res.status(400).json({ error: `Expected ${maxTeamsInt} teams, got ${d.teamIds.length}` })
    }

    const tournament = await prisma.$transaction(async (tx) => {
      const t = await tx.tournament.create({
        data: {
          name: d.name,
          description: d.description,
          format: d.format,
          startDate: new Date(d.startDate),
          endDate: new Date(d.endDate),
          venue: d.venue,
          maxTeams: maxTeamsInt,
          matchTime: d.matchTime ? parseInt(d.matchTime) : 90,
          playingMembers: d.playingMembers ? parseInt(d.playingMembers) : 11,
          maxSubstitutes: d.maxSubstitutes ? parseInt(d.maxSubstitutes) : 5,
          createdById: user.id,
        },
      })

      if (d.teamIds && d.teamIds.length > 0) {
        await tx.tournamentTeam.createMany({
          data: d.teamIds.map((teamId) => ({ tournamentId: t.id, teamId })),
          skipDuplicates: true,
        })
      }

      return t
    })

    res.status(201).json({ tournament })
  })
)

// ─────────────────────────────────────────────────────────────────────────
// GET /:id — tournament details
// PATCH /:id — update tournament (canManageTournament)
// DELETE /:id — soft delete (ADMIN only)
// ─────────────────────────────────────────────────────────────────────────

const updateSchema = z.object({
  name: z.string().min(2).max(100).optional(),
  description: z.string().optional(),
  venue: z.string().optional(),
  startDate: z.string().optional(),
  endDate: z.string().optional(),
  maxTeams: z.string().optional(),
  matchTime: z.string().optional(),
  playingMembers: z.string().optional(),
  maxSubstitutes: z.string().optional(),
})

router.get(
  '/:id',
  requireAuth,
  asyncHandler(async (req, res) => {
    const user = req.user!
    const { id } = req.params

    const tournament = await getTournamentWithDetails(id)
    if (!tournament) return res.status(404).json({ error: 'Not found' })
    if (!tournament.isPublished && !(await canManageTournament(id, user.id, user.role))) {
      return res.status(404).json({ error: 'Not found' })
    }

    res.json({ tournament })
  })
)

router.patch(
  '/:id',
  requireAuth,
  asyncHandler(async (req, res) => {
    const user = req.user!
    const { id } = req.params

    if (!(await canManageTournament(id, user.id, user.role))) {
      return res.status(403).json({ error: 'Forbidden' })
    }

    const parsed = updateSchema.safeParse(req.body)
    if (!parsed.success) return res.status(400).json({ error: 'Invalid data' })

    const d = parsed.data
    const tournament = await prisma.tournament.update({
      where: { id },
      data: {
        ...(d.name ? { name: d.name } : {}),
        ...(d.description !== undefined ? { description: d.description } : {}),
        ...(d.venue !== undefined ? { venue: d.venue } : {}),
        ...(d.startDate ? { startDate: new Date(d.startDate) } : {}),
        ...(d.endDate ? { endDate: new Date(d.endDate) } : {}),
        ...(d.maxTeams ? { maxTeams: parseInt(d.maxTeams) } : {}),
        ...(d.matchTime ? { matchTime: parseInt(d.matchTime) } : {}),
        ...(d.playingMembers ? { playingMembers: parseInt(d.playingMembers) } : {}),
        ...(d.maxSubstitutes ? { maxSubstitutes: parseInt(d.maxSubstitutes) } : {}),
      },
    })

    res.json({ tournament })
  })
)

router.delete(
  '/:id',
  requireAuth,
  asyncHandler(async (req, res) => {
    const user = req.user!
    const { id } = req.params

    if (user.role !== 'ADMIN') return res.status(403).json({ error: 'Forbidden' })

    await prisma.tournament.update({ where: { id }, data: { deletedAt: new Date() } })
    res.json({ success: true })
  })
)

// ─────────────────────────────────────────────────────────────────────────
// PATCH /:id/status — change tournament status (canManageTournament)
// ─────────────────────────────────────────────────────────────────────────

const statusSchema = z.object({
  status: z.enum(['DRAFT', 'UPCOMING', 'ONGOING', 'COMPLETED']),
})

router.patch(
  '/:id/status',
  requireAuth,
  asyncHandler(async (req, res) => {
    const user = req.user!
    const { id } = req.params

    if (!(await canManageTournament(id, user.id, user.role))) {
      return res.status(403).json({ error: 'Forbidden' })
    }

    const parsed = statusSchema.safeParse(req.body)
    if (!parsed.success) return res.status(400).json({ error: 'Invalid status' })

    const tournament = await prisma.tournament.update({
      where: { id },
      data: { status: parsed.data.status },
      select: { id: true, status: true },
    })

    res.json({ tournament })
  })
)

// ─────────────────────────────────────────────────────────────────────────
// POST /:id/publish — publish tournament (ADMIN only)
// ─────────────────────────────────────────────────────────────────────────

router.post(
  '/:id/publish',
  requireAuth,
  requireAdmin,
  asyncHandler(async (req, res) => {
    const { id } = req.params

    const tournament = await prisma.tournament.findUnique({
      where: { id, deletedAt: null },
      select: {
        id: true,
        isPublished: true,
        status: true,
        startDate: true,
        endDate: true,
        maxTeams: true,
        format: true,
        _count: { select: { teams: true } },
        teams: { select: { groupId: true } },
      },
    })
    if (!tournament) return res.status(404).json({ error: 'Not found' })

    if (tournament.isPublished) {
      return res.status(409).json({ error: 'A published tournament cannot be unpublished' })
    }

    // Publishing — validate team count
    if (tournament._count.teams !== tournament.maxTeams) {
      return res.status(409).json({
        error: `Add all teams before publishing (${tournament._count.teams}/${tournament.maxTeams})`,
      })
    }

    // For GROUP_KNOCKOUT: all teams must be assigned to a group
    if (tournament.format === 'GROUP_KNOCKOUT') {
      const unassigned = tournament.teams.filter((t) => !t.groupId).length
      if (unassigned > 0) {
        return res.status(409).json({
          error: `Assign all teams to groups before publishing (${unassigned} unassigned)`,
        })
      }
    }

    // Determine initial status from dates
    const today = new Date()
    today.setHours(0, 0, 0, 0)
    const start = new Date(tournament.startDate)
    start.setHours(0, 0, 0, 0)
    const end = new Date(tournament.endDate)
    end.setHours(0, 0, 0, 0)

    let resolvedStatus: 'UPCOMING' | 'ONGOING' | 'COMPLETED'
    if (today < start) {
      resolvedStatus = 'UPCOMING'
    } else if (today > end) {
      resolvedStatus = 'COMPLETED'
    } else {
      resolvedStatus = 'ONGOING'
    }

    const updated = await prisma.tournament.update({
      where: { id },
      data: { isPublished: true, status: resolvedStatus },
      select: { id: true, isPublished: true, status: true },
    })

    res.json({ isPublished: updated.isPublished, status: updated.status })
  })
)

// ─────────────────────────────────────────────────────────────────────────
// GET /:id/teams — list registered teams
// POST /:id/teams — register a team (TEAM_OWNER, or ADMIN)
// ─────────────────────────────────────────────────────────────────────────

router.get(
  '/:id/teams',
  requireAuth,
  asyncHandler(async (req, res) => {
    const { id } = req.params

    const teams = await prisma.tournamentTeam.findMany({
      where: { tournamentId: id },
      include: {
        team: { select: { id: true, name: true, badgeUrl: true, homeColour: true } },
        group: { select: { id: true, name: true } },
      },
      orderBy: { registeredAt: 'asc' },
    })

    res.json({ teams })
  })
)

router.post(
  '/:id/teams',
  requireAuth,
  requireTeamOwner,
  asyncHandler(async (req, res) => {
    const user = req.user!
    const { id } = req.params

    const parsed = z.object({ teamId: z.string() }).safeParse(req.body)
    if (!parsed.success) return res.status(400).json({ error: 'teamId required' })

    const { teamId } = parsed.data

    // Verify user owns this team (unless admin)
    if (user.role !== 'ADMIN') {
      const team = await prisma.team.findFirst({ where: { id: teamId, ownerId: user.id, deletedAt: null }, select: { id: true } })
      if (!team) return res.status(403).json({ error: 'Forbidden' })
    }

    const tournament = await prisma.tournament.findUnique({
      where: { id, deletedAt: null },
      include: { _count: { select: { teams: true } } },
    })
    if (!tournament) return res.status(404).json({ error: 'Tournament not found' })
    if (user.role !== 'ADMIN' && tournament.status !== 'UPCOMING') {
      return res.status(409).json({ error: 'Tournament is not open for registration' })
    }
    if (tournament._count.teams >= tournament.maxTeams) {
      return res.status(409).json({ error: 'Tournament is full' })
    }

    const existing = await prisma.tournamentTeam.findUnique({
      where: { tournamentId_teamId: { tournamentId: id, teamId } },
      select: { id: true },
    })
    if (existing) return res.status(409).json({ error: 'Team already registered' })

    const tt = await prisma.tournamentTeam.create({
      data: { tournamentId: id, teamId },
      include: { team: { select: { id: true, name: true } } },
    })

    // Notify tournament creator
    if (tournament.createdById !== user.id) {
      await createNotification({
        userId: tournament.createdById,
        title: 'Team Registered',
        body: `${tt.team.name} has registered for ${tournament.name}`,
        link: `/tournaments/${id}`,
      })
    }

    res.status(201).json({ team: tt })
  })
)

// ─────────────────────────────────────────────────────────────────────────
// DELETE /:id/teams/:teamId — unregister a team (ADMIN only)
// ─────────────────────────────────────────────────────────────────────────

router.delete(
  '/:id/teams/:teamId',
  requireAuth,
  requireAdmin,
  asyncHandler(async (req, res) => {
    const { id, teamId } = req.params

    const tt = await prisma.tournamentTeam.findUnique({
      where: { tournamentId_teamId: { tournamentId: id, teamId } },
      select: { id: true },
    })
    if (!tt) return res.status(404).json({ error: 'Team not registered' })

    await prisma.tournamentTeam.delete({
      where: { tournamentId_teamId: { tournamentId: id, teamId } },
    })

    res.json({ ok: true })
  })
)

// ─────────────────────────────────────────────────────────────────────────
// GET /:id/groups — list groups
// POST /:id/groups — create group (canManageTournament)
// ─────────────────────────────────────────────────────────────────────────

router.get(
  '/:id/groups',
  requireAuth,
  asyncHandler(async (req, res) => {
    const { id } = req.params

    const groups = await prisma.tournamentGroup.findMany({
      where: { tournamentId: id },
      include: {
        teams: { include: { team: { select: { id: true, name: true, badgeUrl: true } } } },
      },
      orderBy: { name: 'asc' },
    })

    res.json({ groups })
  })
)

router.post(
  '/:id/groups',
  requireAuth,
  asyncHandler(async (req, res) => {
    const user = req.user!
    const { id } = req.params

    if (!(await canManageTournament(id, user.id, user.role))) {
      return res.status(403).json({ error: 'Forbidden' })
    }

    const parsed = z.object({ name: z.string().min(1).max(50) }).safeParse(req.body)
    if (!parsed.success) return res.status(400).json({ error: 'Name required' })

    const existing = await prisma.tournamentGroup.findUnique({
      where: { tournamentId_name: { tournamentId: id, name: parsed.data.name } },
      select: { id: true },
    })
    if (existing) return res.status(409).json({ error: 'Group name already exists' })

    const group = await prisma.tournamentGroup.create({
      data: { tournamentId: id, name: parsed.data.name },
    })

    res.status(201).json({ group })
  })
)

// ─────────────────────────────────────────────────────────────────────────
// DELETE /:id/groups/:groupId — delete group (canManageTournament)
// ─────────────────────────────────────────────────────────────────────────

router.delete(
  '/:id/groups/:groupId',
  requireAuth,
  asyncHandler(async (req, res) => {
    const user = req.user!
    const { id, groupId } = req.params

    if (!(await canManageTournament(id, user.id, user.role))) {
      return res.status(403).json({ error: 'Forbidden' })
    }

    const group = await prisma.tournamentGroup.findUnique({
      where: { id: groupId },
      select: { id: true, _count: { select: { matches: true } } },
    })
    if (!group) return res.status(404).json({ error: 'Not found' })
    if (group._count.matches > 0) {
      return res.status(409).json({ error: 'Cannot delete group with matches' })
    }

    // Unassign teams from group before deleting
    await prisma.tournamentTeam.updateMany({ where: { groupId }, data: { groupId: null } })
    await prisma.tournamentGroup.delete({ where: { id: groupId } })

    res.json({ success: true })
  })
)

// ─────────────────────────────────────────────────────────────────────────
// POST /:id/groups/:groupId/teams — assign team to group (canManageTournament)
// DELETE /:id/groups/:groupId/teams — unassign team from group (canManageTournament)
// ─────────────────────────────────────────────────────────────────────────

router.post(
  '/:id/groups/:groupId/teams',
  requireAuth,
  asyncHandler(async (req, res) => {
    const user = req.user!
    const { id, groupId } = req.params

    if (!(await canManageTournament(id, user.id, user.role))) {
      return res.status(403).json({ error: 'Forbidden' })
    }

    const parsed = z.object({ teamId: z.string() }).safeParse(req.body)
    if (!parsed.success) return res.status(400).json({ error: 'teamId required' })

    const tt = await prisma.tournamentTeam.findUnique({
      where: { tournamentId_teamId: { tournamentId: id, teamId: parsed.data.teamId } },
      select: { id: true },
    })
    if (!tt) return res.status(404).json({ error: 'Team not registered in this tournament' })

    await prisma.tournamentTeam.update({
      where: { tournamentId_teamId: { tournamentId: id, teamId: parsed.data.teamId } },
      data: { groupId },
    })

    res.json({ success: true })
  })
)

router.delete(
  '/:id/groups/:groupId/teams',
  requireAuth,
  asyncHandler(async (req, res) => {
    const user = req.user!
    const { id, groupId } = req.params

    if (!(await canManageTournament(id, user.id, user.role))) {
      return res.status(403).json({ error: 'Forbidden' })
    }

    const parsed = z.object({ teamId: z.string() }).safeParse(req.body)
    if (!parsed.success) return res.status(400).json({ error: 'teamId required' })

    await prisma.tournamentTeam.updateMany({
      where: { tournamentId: id, teamId: parsed.data.teamId, groupId },
      data: { groupId: null },
    })

    res.json({ success: true })
  })
)

// ─────────────────────────────────────────────────────────────────────────
// GET /:id/coordinators — list coordinators (ADMIN only)
// POST /:id/coordinators — assign coordinator (ADMIN only)
// ─────────────────────────────────────────────────────────────────────────

router.get(
  '/:id/coordinators',
  requireAuth,
  requireAdmin,
  asyncHandler(async (req, res) => {
    const { id } = req.params

    const coordinators = await prisma.tournamentCoordinator.findMany({
      where: { tournamentId: id },
      include: { user: { select: { id: true, displayName: true, avatarUrl: true, email: true } } },
      orderBy: { assignedAt: 'asc' },
    })

    res.json({ coordinators })
  })
)

router.post(
  '/:id/coordinators',
  requireAuth,
  requireAdmin,
  asyncHandler(async (req, res) => {
    const { id } = req.params

    const parsed = z.object({ userId: z.string() }).safeParse(req.body)
    if (!parsed.success) return res.status(400).json({ error: 'userId required' })

    const { userId } = parsed.data

    const user = await prisma.user.findUnique({ where: { id: userId }, select: { id: true, role: true, displayName: true } })
    if (!user) return res.status(404).json({ error: 'User not found' })
    if (user.role !== 'ADMIN') {
      return res.status(400).json({ error: 'User must have ADMIN role' })
    }

    const existing = await prisma.tournamentCoordinator.findUnique({
      where: { tournamentId_userId: { tournamentId: id, userId } },
      select: { id: true },
    })
    if (existing) return res.status(409).json({ error: 'Already assigned' })

    const coordinator = await prisma.tournamentCoordinator.create({
      data: { tournamentId: id, userId },
      include: { user: { select: { id: true, displayName: true, avatarUrl: true, email: true } } },
    })

    res.status(201).json({ coordinator })
  })
)

// ─────────────────────────────────────────────────────────────────────────
// DELETE /:id/coordinators/:userId — remove coordinator (ADMIN only)
// ─────────────────────────────────────────────────────────────────────────

router.delete(
  '/:id/coordinators/:userId',
  requireAuth,
  requireAdmin,
  asyncHandler(async (req, res) => {
    const { id, userId } = req.params

    const c = await prisma.tournamentCoordinator.findUnique({
      where: { tournamentId_userId: { tournamentId: id, userId } },
      select: { id: true },
    })
    if (!c) return res.status(404).json({ error: 'Not found' })

    await prisma.tournamentCoordinator.delete({ where: { tournamentId_userId: { tournamentId: id, userId } } })
    res.json({ success: true })
  })
)

// ─────────────────────────────────────────────────────────────────────────
// GET /:id/matches — list fixtures
// POST /:id/matches — create fixture (canManageTournament)
// ─────────────────────────────────────────────────────────────────────────

const createMatchSchema = z.object({
  homeTeamId: z.string(),
  awayTeamId: z.string(),
  scheduledAt: z.string(),
  venue: z.string().optional(),
  groupId: z.string().optional(),
  round: z.string().optional(),
  bracketSlot: z.number().int().positive().optional(),
  matchOrder: z.number().int().positive().optional(),
  matchTime: z.string().optional(),
  playingMembers: z.string().optional(),
  maxSubstitutes: z.string().optional(),
})

router.get(
  '/:id/matches',
  requireAuth,
  asyncHandler(async (req, res) => {
    const { id } = req.params
    const groupId = (req.query.groupId as string | undefined) ?? undefined
    const round = (req.query.round as string | undefined) ?? undefined

    const matches = await prisma.match.findMany({
      where: {
        tournamentId: id,
        ...(groupId ? { groupId } : {}),
        ...(round ? { round } : {}),
      },
      include: {
        homeTeam: { select: { id: true, name: true, badgeUrl: true, shortCode: true } },
        awayTeam: { select: { id: true, name: true, badgeUrl: true, shortCode: true } },
        group: { select: { id: true, name: true } },
      },
      orderBy: { matchOrder: 'asc' },
    })

    res.json({ matches })
  })
)

router.post(
  '/:id/matches',
  requireAuth,
  asyncHandler(async (req, res) => {
    const user = req.user!
    const { id } = req.params

    if (!(await canManageTournament(id, user.id, user.role))) {
      return res.status(403).json({ error: 'Forbidden' })
    }

    const parsed = createMatchSchema.safeParse(req.body)
    if (!parsed.success) return res.status(400).json({ error: 'Invalid data', issues: parsed.error.issues })

    const d = parsed.data
    if (d.homeTeamId === d.awayTeamId) {
      return res.status(400).json({ error: 'Home and away teams must be different' })
    }

    // Verify both teams are registered
    const registrations = await prisma.tournamentTeam.findMany({
      where: { tournamentId: id, teamId: { in: [d.homeTeamId, d.awayTeamId] } },
      select: { teamId: true },
    })
    if (registrations.length < 2) {
      return res.status(400).json({ error: 'Both teams must be registered in this tournament' })
    }

    const FIXTURE_ALLOWED_STATUSES = ['DRAFT', 'UPCOMING', 'ONGOING']

    const tournament = await prisma.tournament.findUnique({
      where: { id, deletedAt: null },
      select: { matchTime: true, playingMembers: true, maxSubstitutes: true, status: true, venue: true, knockoutRoundSize: true },
    })
    if (!tournament) return res.status(404).json({ error: 'Tournament not found' })
    if (!FIXTURE_ALLOWED_STATUSES.includes(tournament.status)) {
      return res.status(409).json({ error: 'Fixtures can only be created for Draft, Upcoming, or Ongoing tournaments' })
    }

    // Knockout bracket round-1 slot — validate and derive the round label from tournament.knockoutRoundSize
    let bracketRoundSize: number | undefined
    if (d.bracketSlot !== undefined) {
      if (!tournament.knockoutRoundSize) {
        return res.status(409).json({ error: 'Start the knockout stage before creating knockout fixtures' })
      }
      if (d.bracketSlot > tournament.knockoutRoundSize) {
        return res.status(400).json({ error: `Bracket slot must be between 1 and ${tournament.knockoutRoundSize}` })
      }
      const slotTaken = await prisma.match.findFirst({
        where: { tournamentId: id, bracketRoundSize: tournament.knockoutRoundSize, bracketSlot: d.bracketSlot },
        select: { id: true },
      })
      if (slotTaken) {
        return res.status(409).json({ error: `Bracket slot ${d.bracketSlot} is already filled` })
      }
      bracketRoundSize = tournament.knockoutRoundSize
    }

    // Use caller-supplied match order, or auto-assign after the last existing one
    let matchOrder = d.matchOrder
    if (!matchOrder) {
      const lastMatch = await prisma.match.findFirst({
        where: { tournamentId: id },
        orderBy: { matchOrder: 'desc' },
        select: { matchOrder: true },
      })
      matchOrder = (lastMatch?.matchOrder ?? 0) + 1
    }

    // Check matchOrder uniqueness within this tournament
    if (matchOrder) {
      const conflict = await prisma.match.findUnique({
        where: { tournamentId_matchOrder: { tournamentId: id, matchOrder } },
        select: { id: true },
      })
      if (conflict) {
        return res.status(409).json({
          error: `Match #${matchOrder} already exists in this tournament. Use a different number.`,
        })
      }
    }

    const matchTime = d.matchTime ? parseInt(d.matchTime) : tournament.matchTime
    const playingMembers = d.playingMembers ? parseInt(d.playingMembers) : tournament.playingMembers
    const maxSubstitutes = d.maxSubstitutes ? parseInt(d.maxSubstitutes) : tournament.maxSubstitutes

    const match = await prisma.$transaction(async (tx) => {
      const created = await tx.match.create({
        data: {
          tournamentId: id,
          homeTeamId: d.homeTeamId,
          awayTeamId: d.awayTeamId,
          matchOrder,
          scheduledAt: new Date(d.scheduledAt),
          venue: d.venue,
          groupId: bracketRoundSize ? null : (d.groupId ?? null),
          round: bracketRoundSize ? roundLabel(bracketRoundSize) : (d.round ?? null),
          bracketRoundSize: bracketRoundSize ?? null,
          bracketSlot: bracketRoundSize ? d.bracketSlot : null,
          matchTime,
          playingMembers,
          maxSubstitutes,
        },
        include: {
          homeTeam: { select: { id: true, name: true, badgeUrl: true, shortCode: true } },
          awayTeam: { select: { id: true, name: true, badgeUrl: true, shortCode: true } },
        },
      })

      // Once round 1 is fully populated, build out the rest of the bracket as TBD placeholders
      if (bracketRoundSize) {
        await maybeGenerateBracketSkeleton(tx, id, bracketRoundSize, {
          matchTime, playingMembers, maxSubstitutes, venue: tournament.venue ?? null,
        })
      }

      return created
    })

    res.status(201).json({ match })
  })
)

// ─────────────────────────────────────────────────────────────────────────
// POST /:id/knockout-bracket/start — start knockout stage (canManageTournament)
// ─────────────────────────────────────────────────────────────────────────

const knockoutStartSchema = z.object({
  teams: z.number().int().min(2),
})

router.post(
  '/:id/knockout-bracket/start',
  requireAuth,
  asyncHandler(async (req, res) => {
    const user = req.user!
    const { id } = req.params

    if (!(await canManageTournament(id, user.id, user.role))) {
      return res.status(403).json({ error: 'Forbidden' })
    }

    const parsed = knockoutStartSchema.safeParse(req.body)
    if (!parsed.success) return res.status(400).json({ error: 'Invalid data', issues: parsed.error.issues })

    if (!isPowerOfTwo(parsed.data.teams)) {
      return res.status(400).json({ error: 'Number of qualifying teams must be a power of two (4, 8, 16, 32, 64...)' })
    }

    const tournament = await prisma.tournament.findUnique({
      where: { id, deletedAt: null },
      select: {
        format: true,
        knockoutRoundSize: true,
        _count: { select: { teams: true } },
      },
    })
    if (!tournament) return res.status(404).json({ error: 'Tournament not found' })

    if (tournament.format !== 'GROUP_KNOCKOUT') {
      return res.status(409).json({ error: 'Knockout bracket setup is only available for Group + Knockout tournaments' })
    }
    if (tournament.knockoutRoundSize !== null) {
      return res.status(409).json({ error: 'Knockout stage has already been started' })
    }
    if (parsed.data.teams > tournament._count.teams) {
      return res.status(409).json({ error: `Only ${tournament._count.teams} teams are registered` })
    }

    const unfinishedGroupMatches = await prisma.match.count({
      where: { tournamentId: id, groupId: { not: null }, status: { not: 'COMPLETED' } },
    })
    if (unfinishedGroupMatches > 0) {
      return res.status(409).json({
        error: `${unfinishedGroupMatches} group-stage match(es) are not yet completed`,
      })
    }

    const updated = await prisma.tournament.update({
      where: { id },
      data: { knockoutRoundSize: parsed.data.teams / 2 },
      select: { knockoutRoundSize: true },
    })

    res.json({ knockoutRoundSize: updated.knockoutRoundSize })
  })
)

// ─────────────────────────────────────────────────────────────────────────
// GET /:id/standings — league or group standings
// ─────────────────────────────────────────────────────────────────────────

router.get(
  '/:id/standings',
  requireAuth,
  asyncHandler(async (req, res) => {
    const { id } = req.params

    const tournament = await prisma.tournament.findUnique({
      where: { id, deletedAt: null },
      select: { format: true },
    })
    if (!tournament) return res.status(404).json({ error: 'Not found' })

    if (tournament.format === 'GROUP_KNOCKOUT') {
      const groups = await calculateGroupStandings(id)
      return res.json({ type: 'group', groups })
    }

    const rows = await calculateStandings(id)
    res.json({ type: 'league', rows })
  })
)

export const tournamentsRouter = router
