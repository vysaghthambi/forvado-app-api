import { prisma } from '../lib/prisma.js'
import type { Role, TournamentStatus } from '@prisma/client'

export async function getTournamentWithDetails(id: string) {
  return prisma.tournament.findUnique({
    where: { id, deletedAt: null },
    include: {
      createdBy: { select: { id: true, displayName: true, avatarUrl: true } },
      groups: { orderBy: { name: 'asc' } },
      teams: {
        include: {
          team: { select: { id: true, name: true, badgeUrl: true } },
          group: { select: { id: true, name: true } },
        },
        orderBy: { registeredAt: 'asc' },
      },
      coordinators: {
        include: { user: { select: { id: true, displayName: true, avatarUrl: true, email: true } } },
      },
      _count: { select: { matches: true } },
    },
  })
}

export async function isTournamentCoordinator(tournamentId: string, userId: string) {
  const c = await prisma.tournamentCoordinator.findUnique({
    where: { tournamentId_userId: { tournamentId, userId } },
    select: { id: true },
  })
  return !!c
}

export async function canManageTournament(
  tournamentId: string,
  userId: string,
  userRole: Role
): Promise<boolean> {
  if (userRole === 'ADMIN') return true
  return isTournamentCoordinator(tournamentId, userId)
}

export async function autoUpdateTournamentStatus(
  id: string,
  tournament: { status: TournamentStatus; startDate: Date; endDate: Date; isPublished: boolean }
): Promise<TournamentStatus> {
  if (!tournament.isPublished) return tournament.status

  const today = new Date()
  let newStatus: TournamentStatus | null = null

  if (tournament.status === 'UPCOMING' && today >= tournament.startDate) {
    newStatus = 'ONGOING'
  } else if (tournament.status === 'ONGOING' && today > tournament.endDate) {
    newStatus = 'COMPLETED'
  }

  if (newStatus) {
    await prisma.tournament.update({ where: { id }, data: { status: newStatus } })
    return newStatus
  }

  return tournament.status
}
