import { prisma } from '../lib/prisma.js'

export async function getTeamWithDetails(teamId: string) {
  return prisma.team.findUnique({
    where: { id: teamId, deletedAt: null },
    include: {
      owner: { select: { id: true, displayName: true, avatarUrl: true } },
      members: {
        where: { status: 'ACTIVE' },
        include: {
          user: { select: { id: true, displayName: true, avatarUrl: true, position: true } },
        },
        orderBy: { joinedAt: 'asc' },
      },
    },
  })
}

export async function isTeamOwner(teamId: string, userId: string) {
  const team = await prisma.team.findFirst({
    where: { id: teamId, ownerId: userId, deletedAt: null },
    select: { id: true },
  })
  return !!team
}

export async function isTeamMember(teamId: string, userId: string) {
  const membership = await prisma.teamMembership.findUnique({
    where: { teamId_userId: { teamId, userId } },
    select: { status: true },
  })
  return membership?.status === 'ACTIVE'
}

export async function hasPendingInvitation(teamId: string, userId: string) {
  const inv = await prisma.teamInvitation.findFirst({
    where: { teamId, userId, status: 'PENDING' },
    select: { id: true },
  })
  return !!inv
}
