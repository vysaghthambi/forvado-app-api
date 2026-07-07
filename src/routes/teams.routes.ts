import express from 'express'
import { z } from 'zod'
import { prisma } from '../lib/prisma.js'
import { requireAuth } from '../middleware/auth.js'
import { asyncHandler } from '../middleware/errorHandler.js'
import { getTeamWithDetails, isTeamOwner, isTeamMember, hasPendingInvitation } from '../services/teams.js'
import { createNotification } from '../services/notifications.js'

const router = express.Router()

// ---------------------------------------------------------------------------
// GET / — list teams
// POST / — create a team (ADMIN or TEAM_OWNER only)
// ---------------------------------------------------------------------------

const createSchema = z.object({
  name: z.string().min(2).max(60),
  description: z.string().max(500).optional().nullable(),
  homeColour: z.string().regex(/^#[0-9A-Fa-f]{6}$/, 'Invalid hex colour').optional().nullable(),
  shortCode: z.string().min(2).max(3).regex(/^[A-Z]{2,3}$/).optional().nullable(),
  badgeUrl: z.string().url().optional().nullable(),
  isAcceptingRequests: z.boolean().optional(),
})

router.get(
  '/',
  requireAuth,
  asyncHandler(async (req, res) => {
    const accepting = req.query.accepting === 'true'
    const page = Math.max(1, parseInt((req.query.page as string) ?? '1', 10))
    const limit = Math.min(50, parseInt((req.query.limit as string) ?? '20', 10))
    const skip = (page - 1) * limit
    const q = (req.query.q as string | undefined)?.trim()

    const where = {
      deletedAt: null,
      ...(accepting && { isAcceptingRequests: true }),
      ...(q && { name: { contains: q, mode: 'insensitive' as const } }),
    }

    const [teams, total] = await prisma.$transaction([
      prisma.team.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
        include: {
          owner: { select: { id: true, displayName: true, avatarUrl: true } },
          _count: { select: { members: true } },
        },
      }),
      prisma.team.count({ where }),
    ])

    res.json({ teams, total, page, limit })
  })
)

router.post(
  '/',
  requireAuth,
  asyncHandler(async (req, res) => {
    const user = req.user!

    if (user.role !== 'ADMIN' && user.role !== 'TEAM_OWNER') {
      return res.status(403).json({ error: 'Only admins and team owners can create teams' })
    }

    const parsed = createSchema.safeParse(req.body)
    if (!parsed.success) {
      return res.status(400).json({ error: 'Validation failed', details: parsed.error.flatten() })
    }

    const team = await prisma.team.create({
      data: {
        ...parsed.data,
        ownerId: user.id,
      },
    })

    // Auto-add creator as CAPTAIN member
    await prisma.teamMembership.create({
      data: { teamId: team.id, userId: user.id, role: 'CAPTAIN', status: 'ACTIVE' },
    })

    res.status(201).json({ team })
  })
)

// ---------------------------------------------------------------------------
// GET /:id — team details
// PATCH /:id — update team (owner or ADMIN)
// DELETE /:id — soft-delete team (owner or ADMIN)
// ---------------------------------------------------------------------------

const updateSchema = z.object({
  name: z.string().min(2).max(60).optional(),
  description: z.string().max(500).nullable().optional(),
  homeColour: z.string().regex(/^#[0-9A-Fa-f]{6}$/).nullable().optional(),
  shortCode: z.string().min(2).max(3).regex(/^[A-Z]{2,3}$/).nullable().optional(),
  badgeUrl: z.string().url().nullable().optional(),
  isAcceptingRequests: z.boolean().optional(),
})

router.get(
  '/:id',
  requireAuth,
  asyncHandler(async (req, res) => {
    const { id } = req.params
    const team = await getTeamWithDetails(id)
    if (!team) return res.status(404).json({ error: 'Team not found' })

    res.json({ team })
  })
)

router.patch(
  '/:id',
  requireAuth,
  asyncHandler(async (req, res) => {
    const user = req.user!
    const { id } = req.params

    const team = await prisma.team.findUnique({ where: { id, deletedAt: null } })
    if (!team) return res.status(404).json({ error: 'Team not found' })
    if (team.ownerId !== user.id && user.role !== 'ADMIN') {
      return res.status(403).json({ error: 'Forbidden' })
    }

    const parsed = updateSchema.safeParse(req.body)
    if (!parsed.success) {
      return res.status(400).json({ error: 'Validation failed', details: parsed.error.flatten() })
    }

    const updated = await prisma.team.update({ where: { id }, data: parsed.data })
    res.json({ team: updated })
  })
)

router.delete(
  '/:id',
  requireAuth,
  asyncHandler(async (req, res) => {
    const user = req.user!
    const { id } = req.params

    const team = await prisma.team.findUnique({ where: { id, deletedAt: null } })
    if (!team) return res.status(404).json({ error: 'Team not found' })
    if (team.ownerId !== user.id && user.role !== 'ADMIN') {
      return res.status(403).json({ error: 'Forbidden' })
    }

    await prisma.team.update({ where: { id }, data: { deletedAt: new Date() } })
    res.json({ success: true })
  })
)

// ---------------------------------------------------------------------------
// POST /:id/invite — team owner (or ADMIN) invites a user to the team
// ---------------------------------------------------------------------------

const inviteSchema = z.object({ userId: z.string().min(1) })

router.post(
  '/:id/invite',
  requireAuth,
  asyncHandler(async (req, res) => {
    const user = req.user!
    const teamId = req.params.id

    if (!(await isTeamOwner(teamId, user.id)) && user.role !== 'ADMIN') {
      return res.status(403).json({ error: 'Forbidden' })
    }

    const parsed = inviteSchema.safeParse(req.body)
    if (!parsed.success) {
      return res.status(400).json({ error: 'Validation failed', details: parsed.error.flatten() })
    }

    const { userId } = parsed.data

    // Run all validation queries in parallel
    const [target, membership, pendingInvite, team] = await Promise.all([
      prisma.user.findUnique({ where: { id: userId }, select: { id: true, displayName: true } }),
      prisma.teamMembership.findUnique({ where: { teamId_userId: { teamId, userId } }, select: { status: true } }),
      prisma.teamInvitation.findFirst({ where: { teamId, userId, status: 'PENDING' }, select: { id: true } }),
      prisma.team.findUnique({ where: { id: teamId }, select: { name: true } }),
    ])

    if (!target) return res.status(404).json({ error: 'User not found' })
    if (membership?.status === 'ACTIVE') return res.status(409).json({ error: 'User is already a member' })
    if (pendingInvite) return res.status(409).json({ error: 'A pending invitation already exists' })

    const invitation = await prisma.teamInvitation.create({
      data: { teamId, userId, type: 'INVITE', status: 'PENDING' },
    })

    // Create in-app notification for the invited user
    await createNotification({
      userId,
      title: 'Team Invitation',
      body: `You have been invited to join ${team?.name}.`,
      link: `/teams/${teamId}`,
    })

    res.status(201).json({ invitation })
  })
)

// ---------------------------------------------------------------------------
// POST /:id/request — a player requests to join an open team
// ---------------------------------------------------------------------------

router.post(
  '/:id/request',
  requireAuth,
  asyncHandler(async (req, res) => {
    const user = req.user!
    const teamId = req.params.id

    const team = await prisma.team.findUnique({
      where: { id: teamId, deletedAt: null },
      select: { id: true, name: true, isAcceptingRequests: true, ownerId: true },
    })
    if (!team) return res.status(404).json({ error: 'Team not found' })
    if (!team.isAcceptingRequests) {
      return res.status(409).json({ error: 'Team is not accepting requests' })
    }
    if (await isTeamMember(teamId, user.id)) {
      return res.status(409).json({ error: 'Already a member' })
    }
    if (await hasPendingInvitation(teamId, user.id)) {
      return res.status(409).json({ error: 'A pending request already exists' })
    }

    const invitation = await prisma.teamInvitation.create({
      data: { teamId, userId: user.id, type: 'JOIN_REQUEST', status: 'PENDING' },
    })

    // Notify the team owner
    await createNotification({
      userId: team.ownerId,
      title: 'New Join Request',
      body: `${user.displayName} has requested to join ${team.name}.`,
      link: `/teams/${teamId}/invitations`,
    })

    res.status(201).json({ invitation })
  })
)

// ---------------------------------------------------------------------------
// GET /:id/invitations — team owner (or ADMIN) lists pending invitations
// ---------------------------------------------------------------------------

router.get(
  '/:id/invitations',
  requireAuth,
  asyncHandler(async (req, res) => {
    const user = req.user!
    const teamId = req.params.id

    if (!(await isTeamOwner(teamId, user.id)) && user.role !== 'ADMIN') {
      return res.status(403).json({ error: 'Forbidden' })
    }

    const invitations = await prisma.teamInvitation.findMany({
      where: { teamId, status: 'PENDING' },
      include: {
        user: { select: { id: true, displayName: true, avatarUrl: true, position: true, jerseyNumber: true } },
      },
      orderBy: { createdAt: 'desc' },
    })

    res.json({ invitations })
  })
)

// ---------------------------------------------------------------------------
// PATCH /:id/invitations/:invId — accept/reject an invitation or join request
// ---------------------------------------------------------------------------

const invitationActionSchema = z.object({ action: z.enum(['ACCEPT', 'REJECT']) })

router.patch(
  '/:id/invitations/:invId',
  requireAuth,
  asyncHandler(async (req, res) => {
    const user = req.user!
    const { id: teamId, invId } = req.params

    const invitation = await prisma.teamInvitation.findUnique({
      where: { id: invId },
      include: { team: { select: { id: true, name: true, ownerId: true } } },
    })

    if (!invitation || invitation.teamId !== teamId) {
      return res.status(404).json({ error: 'Invitation not found' })
    }
    if (invitation.status !== 'PENDING') {
      return res.status(409).json({ error: 'Invitation already resolved' })
    }

    // Permission check: owner handles JOIN_REQUESTs, invitee handles INVITEs
    const isOwner = invitation.team.ownerId === user.id || user.role === 'ADMIN'
    const isInvitee = invitation.userId === user.id

    if (invitation.type === 'JOIN_REQUEST' && !isOwner) {
      return res.status(403).json({ error: 'Forbidden' })
    }
    if (invitation.type === 'INVITE' && !isInvitee && !isOwner) {
      return res.status(403).json({ error: 'Forbidden' })
    }

    const parsed = invitationActionSchema.safeParse(req.body)
    if (!parsed.success) {
      return res.status(400).json({ error: 'Validation failed', details: parsed.error.flatten() })
    }

    const { action } = parsed.data

    const updated = await prisma.teamInvitation.update({
      where: { id: invId },
      data: { status: action === 'ACCEPT' ? 'ACCEPTED' : 'REJECTED', respondedAt: new Date() },
    })

    // On acceptance — add the user to the team
    if (action === 'ACCEPT') {
      await prisma.teamMembership.upsert({
        where: { teamId_userId: { teamId, userId: invitation.userId } },
        create: { teamId, userId: invitation.userId, role: 'PLAYER', status: 'ACTIVE' },
        update: { status: 'ACTIVE' },
      })

      // Notify the relevant party
      if (invitation.type === 'INVITE') {
        // Owner gets notified when invitee accepts
        await createNotification({
          userId: invitation.team.ownerId,
          title: 'Invitation Accepted',
          body: `A player has joined ${invitation.team.name}.`,
          link: `/teams/${teamId}`,
        })
      } else {
        // Player gets notified when owner accepts join request
        await createNotification({
          userId: invitation.userId,
          title: 'Join Request Accepted',
          body: `Your request to join ${invitation.team.name} was accepted!`,
          link: `/teams/${teamId}`,
        })
      }
    } else {
      // Notify on rejection too
      if (invitation.type === 'JOIN_REQUEST') {
        await createNotification({
          userId: invitation.userId,
          title: 'Join Request Declined',
          body: `Your request to join ${invitation.team.name} was declined.`,
          link: `/teams`,
        })
      }
    }

    res.json({ invitation: updated })
  })
)

// ---------------------------------------------------------------------------
// POST /:id/members — team owner (or ADMIN) bulk-adds players directly
// ---------------------------------------------------------------------------

const addMembersSchema = z.object({
  userIds: z.array(z.string()).min(1).max(50),
})

router.post(
  '/:id/members',
  requireAuth,
  asyncHandler(async (req, res) => {
    const user = req.user!
    const teamId = req.params.id

    const team = await prisma.team.findUnique({
      where: { id: teamId },
      select: { ownerId: true },
    })
    if (!team) return res.status(404).json({ error: 'Team not found' })
    if (team.ownerId !== user.id && user.role !== 'ADMIN') {
      return res.status(403).json({ error: 'Forbidden' })
    }

    const parsed = addMembersSchema.safeParse(req.body)
    if (!parsed.success) return res.status(400).json({ error: 'Invalid data' })

    const { userIds } = parsed.data

    // Check existing members to avoid duplicates
    const existing = await prisma.teamMembership.findMany({
      where: { teamId, userId: { in: userIds } },
      select: { userId: true },
    })
    const existingIds = new Set(existing.map((m) => m.userId))
    const toAdd = userIds.filter((id) => !existingIds.has(id))

    if (toAdd.length === 0) {
      return res.status(409).json({ error: 'All selected players are already on the team' })
    }

    await prisma.teamMembership.createMany({
      data: toAdd.map((userId) => ({
        teamId,
        userId,
        role: 'PLAYER',
        status: 'ACTIVE',
      })),
      skipDuplicates: true,
    })

    res.status(201).json({ added: toAdd.length })
  })
)

// ---------------------------------------------------------------------------
// DELETE /:id/members/:userId — team owner (or ADMIN) removes (deactivates) a member
// ---------------------------------------------------------------------------

router.delete(
  '/:id/members/:userId',
  requireAuth,
  asyncHandler(async (req, res) => {
    const user = req.user!
    const teamId = req.params.id
    const targetUserId = req.params.userId

    if (!(await isTeamOwner(teamId, user.id)) && user.role !== 'ADMIN') {
      return res.status(403).json({ error: 'Forbidden' })
    }

    // Prevent removing the owner themselves
    const team = await prisma.team.findUnique({ where: { id: teamId }, select: { ownerId: true } })
    if (team?.ownerId === targetUserId) {
      return res.status(409).json({ error: 'Cannot remove the team owner' })
    }

    const membership = await prisma.teamMembership.findUnique({
      where: { teamId_userId: { teamId, userId: targetUserId } },
    })
    if (!membership) return res.status(404).json({ error: 'Member not found' })

    await prisma.teamMembership.update({
      where: { teamId_userId: { teamId, userId: targetUserId } },
      data: { status: 'INACTIVE' },
    })

    res.json({ success: true })
  })
)

export const teamsRouter = router
