import { Router } from 'express'
import { z } from 'zod'
import type { Role } from '@prisma/client'
import { prisma } from '../lib/prisma.js'
import { requireAuth, requireAdmin } from '../middleware/auth.js'
import { asyncHandler } from '../middleware/errorHandler.js'

const router = Router()

// GET /  — list users (admin only)
router.get(
  '/',
  requireAuth,
  requireAdmin,
  asyncHandler(async (req, res) => {
    const page = Math.max(1, parseInt((req.query.page as string) ?? '1', 10))
    const limit = Math.min(200, parseInt((req.query.limit as string) ?? '20', 10))
    const skip = (page - 1) * limit
    const q = (req.query.q as string | undefined)?.trim() || undefined
    const role = (req.query.role as string | undefined)?.trim() || undefined

    const where = {
      ...(q && {
        OR: [
          { displayName: { contains: q, mode: 'insensitive' as const } },
          { email: { contains: q, mode: 'insensitive' as const } },
        ],
      }),
      ...(role && { role: role as Role }),
    }

    const [users, total] = await prisma.$transaction([
      prisma.user.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          displayName: true,
          email: true,
          role: true,
          position: true,
          jerseyNumber: true,
          avatarUrl: true,
          profileComplete: true,
          createdAt: true,
          _count: { select: { teamMemberships: true } },
        },
      }),
      prisma.user.count({ where }),
    ])

    res.json({ users, total, page, limit })
  })
)

// GET /me — own profile
router.get(
  '/me',
  requireAuth,
  asyncHandler(async (req, res) => {
    const user = req.user!

    const dbUser = await prisma.user.findUnique({ where: { authId: user.authId } })
    if (!dbUser) return res.status(404).json({ error: 'Not found' })

    res.json({ user: dbUser })
  })
)

const updateSchema = z.object({
  displayName: z.string().min(2).max(50).optional(),
  position: z.enum(['GK', 'DEF', 'MID', 'FWD']).optional(),
  jerseyNumber: z.number().int().min(1).max(99).optional(),
  dateOfBirth: z.string().datetime().nullable().optional(),
  avatarUrl: z.string().url().nullable().optional(),
})

// PATCH /me — update own profile
router.patch(
  '/me',
  requireAuth,
  asyncHandler(async (req, res) => {
    const user = req.user!

    const parsed = updateSchema.safeParse(req.body)
    if (!parsed.success) {
      return res.status(400).json({ error: 'Validation failed', details: parsed.error.flatten() })
    }

    const data = parsed.data
    const updated = await prisma.user.update({
      where: { authId: user.authId },
      data: {
        ...data,
        dateOfBirth: data.dateOfBirth ? new Date(data.dateOfBirth) : undefined,
      },
    })

    res.json({ user: updated })
  })
)

// GET /search — search users
router.get(
  '/search',
  requireAuth,
  asyncHandler(async (req, res) => {
    const q = ((req.query.q as string | undefined) ?? '').trim()
    if (q.length < 2) return res.json({ users: [] })

    const users = await prisma.user.findMany({
      where: {
        profileComplete: true,
        OR: [
          { displayName: { contains: q, mode: 'insensitive' } },
          { email: { contains: q, mode: 'insensitive' } },
        ],
      },
      select: { id: true, displayName: true, email: true, avatarUrl: true, role: true },
      take: 10,
      orderBy: { displayName: 'asc' },
    })

    res.json({ users })
  })
)

const setupSchema = z.object({
  displayName: z.string().min(2).max(50),
  position: z.enum(['GK', 'DEF', 'MID', 'FWD']),
  jerseyNumber: z.number().int().min(1).max(99),
  dateOfBirth: z.string().datetime().optional().nullable(),
  avatarUrl: z.string().url().optional().nullable(),
})

// POST /setup — complete profile setup wizard
router.post(
  '/setup',
  requireAuth,
  asyncHandler(async (req, res) => {
    const user = req.user!

    const parsed = setupSchema.safeParse(req.body)
    if (!parsed.success) {
      return res.status(400).json({ error: 'Validation failed', details: parsed.error.flatten() })
    }

    const { displayName, position, jerseyNumber, dateOfBirth, avatarUrl } = parsed.data

    const dbUser = await prisma.user.findUnique({ where: { authId: user.authId } })
    if (!dbUser) {
      return res.status(404).json({ error: 'User record not found' })
    }

    const updated = await prisma.user.update({
      where: { authId: user.authId },
      data: {
        displayName,
        position,
        jerseyNumber,
        dateOfBirth: dateOfBirth ? new Date(dateOfBirth) : null,
        avatarUrl: avatarUrl ?? null,
        profileComplete: true,
      },
    })

    res.json({ user: updated })
  })
)

const roleSchema = z.object({
  role: z.enum(['PLAYER', 'TEAM_OWNER', 'ADMIN']),
})

// PATCH /:id/role — admin changes a user's role
router.patch(
  '/:id/role',
  requireAuth,
  requireAdmin,
  asyncHandler(async (req, res) => {
    const { id } = req.params

    const parsed = roleSchema.safeParse(req.body)
    if (!parsed.success) {
      return res.status(400).json({ error: 'Validation failed', details: parsed.error.flatten() })
    }

    const target = await prisma.user.findUnique({ where: { id } })
    if (!target) return res.status(404).json({ error: 'User not found' })

    const updated = await prisma.user.update({
      where: { id },
      data: { role: parsed.data.role },
    })

    res.json({ user: updated })
  })
)

export const usersRouter = router
