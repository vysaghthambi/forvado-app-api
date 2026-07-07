import { prisma } from '../lib/prisma.js'

interface CreateNotificationInput {
  userId: string
  title: string
  body: string
  link?: string
}

export async function createNotification(input: CreateNotificationInput) {
  return prisma.notification.create({ data: input })
}

export async function createNotifications(inputs: CreateNotificationInput[]) {
  return prisma.notification.createMany({ data: inputs })
}
