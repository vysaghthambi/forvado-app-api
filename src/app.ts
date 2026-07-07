import express from 'express'
import cors from 'cors'
import helmet from 'helmet'
import { errorHandler, notFoundHandler } from './middleware/errorHandler.js'
import { usersRouter } from './routes/users.routes.js'
import { teamsRouter } from './routes/teams.routes.js'
import { tournamentsRouter } from './routes/tournaments.routes.js'
import { matchesRouter } from './routes/matches.routes.js'
import { notificationsRouter } from './routes/notifications.routes.js'

export function createApp() {
  const app = express()

  app.use(helmet())
  app.use(
    cors({
      origin: process.env.CORS_ORIGIN?.split(',') ?? true,
      credentials: true,
    })
  )
  app.use(express.json())

  app.get('/health', (_req, res) => res.json({ ok: true }))

  app.use('/api/users', usersRouter)
  app.use('/api/teams', teamsRouter)
  app.use('/api/tournaments', tournamentsRouter)
  app.use('/api/matches', matchesRouter)
  app.use('/api/notifications', notificationsRouter)

  app.use(notFoundHandler)
  app.use(errorHandler)

  return app
}
