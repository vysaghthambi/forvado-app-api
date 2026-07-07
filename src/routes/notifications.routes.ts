import express from 'express'
import { prisma } from '../lib/prisma.js'
import { requireAuth } from '../middleware/auth.js'
import { asyncHandler } from '../middleware/errorHandler.js'

const router = express.Router()

// ---------------------------------------------------------------------------
// GET / — list current user's notifications (paginated)
// ---------------------------------------------------------------------------

router.get(
  '/',
  requireAuth,
  asyncHandler(async (req, res) => {
    const user = req.user!

    const page = Math.max(1, parseInt((req.query.page as string) ?? '1', 10))
    const limit = Math.min(50, parseInt((req.query.limit as string) ?? '20', 10))
    const skip = (page - 1) * limit

    const [notifications, total, unreadCount] = await prisma.$transaction([
      prisma.notification.findMany({
        where: { userId: user.id },
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      prisma.notification.count({ where: { userId: user.id } }),
      prisma.notification.count({ where: { userId: user.id, read: false } }),
    ])

    res.json({ notifications, total, unreadCount, page, limit })
  })
)

// ---------------------------------------------------------------------------
// POST /read-all — mark all of the current user's notifications as read
// ---------------------------------------------------------------------------

router.post(
  '/read-all',
  requireAuth,
  asyncHandler(async (req, res) => {
    const user = req.user!

    await prisma.notification.updateMany({
      where: { userId: user.id, read: false },
      data: { read: true },
    })

    res.json({ success: true })
  })
)

// ---------------------------------------------------------------------------
// PATCH /:id/read — mark one notification as read (owner only)
// ---------------------------------------------------------------------------

router.patch(
  '/:id/read',
  requireAuth,
  asyncHandler(async (req, res) => {
    const user = req.user!
    const { id } = req.params

    const notification = await prisma.notification.findUnique({ where: { id } })

    if (!notification || notification.userId !== user.id) {
      return res.status(404).json({ error: 'Not found' })
    }

    const updated = await prisma.notification.update({ where: { id }, data: { read: true } })
    res.json({ notification: updated })
  })
)

export const notificationsRouter = router
