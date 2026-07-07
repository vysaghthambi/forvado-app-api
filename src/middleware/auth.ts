import type { NextFunction, Request, Response } from 'express'
import { prisma } from '../lib/prisma.js'
import { supabaseAdmin } from '../lib/supabaseAdmin.js'
import type { Role, User } from '@prisma/client'

declare global {
  namespace Express {
    interface Request {
      user?: User
    }
  }
}

/**
 * Hierarchy: ADMIN > TEAM_OWNER > PLAYER
 */
export const ROLE_HIERARCHY: Record<Role, number> = {
  PLAYER: 0,
  TEAM_OWNER: 1,
  ADMIN: 2,
}

export function hasRole(userRole: Role, requiredRole: Role): boolean {
  return ROLE_HIERARCHY[userRole] >= ROLE_HIERARCHY[requiredRole]
}

async function findOrCreateUser(authId: string, email: string): Promise<User> {
  const existing = await prisma.user.findUnique({ where: { authId } })
  if (existing) return existing

  return prisma.user.create({
    data: {
      authId,
      email,
      displayName: email.split('@')[0],
      role: 'PLAYER',
      profileComplete: false,
    },
  })
}

/**
 * Verifies the `Authorization: Bearer <token>` header against Supabase,
 * finds-or-creates the corresponding DB User, and attaches it to `req.user`.
 * Responds 401 if the token is missing/invalid.
 */
export async function requireAuth(req: Request, res: Response, next: NextFunction) {
  const authHeader = req.headers.authorization
  const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null

  if (!token) {
    return res.status(401).json({ error: 'Unauthorized' })
  }

  const {
    data: { user: authUser },
    error: authError,
  } = await supabaseAdmin.auth.getUser(token)

  if (authError || !authUser || !authUser.email) {
    return res.status(401).json({ error: 'Unauthorized' })
  }

  req.user = await findOrCreateUser(authUser.id, authUser.email)
  next()
}

/**
 * Like requireAuth but additionally enforces a minimum role.
 * Must run after requireAuth (relies on req.user being set).
 */
export function requireRole(minimumRole: Role) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) {
      return res.status(401).json({ error: 'Unauthorized' })
    }
    if (!hasRole(req.user.role, minimumRole)) {
      return res.status(403).json({ error: 'Forbidden' })
    }
    next()
  }
}

export const requireAdmin = requireRole('ADMIN')
export const requireTeamOwner = requireRole('TEAM_OWNER')
export const requirePlayer = requireRole('PLAYER')
