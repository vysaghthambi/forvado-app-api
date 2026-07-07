import { createRequire } from 'node:module'
import express from 'express'
import cors from 'cors'
import { errorHandler, notFoundHandler } from './middleware/errorHandler.js'

// helmet 8.2's split ESM/CJS type declarations resolve inconsistently across
// TypeScript/bundler configurations (some resolve the default export as the
// whole module namespace instead of the callable function). Loading via
// createRequire sidesteps the ambiguity — this is always the real CJS
// module.exports, which is the callable helmet function itself.
const require = createRequire(import.meta.url)
const helmet: typeof import('helmet').default = require('helmet')
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

// Some Vercel project configurations invoke this file directly as the
// serverless function entry (rather than api/index.ts) — see README's
// "Deploying to Vercel" section. Vercel's Node runtime requires the
// invoked module's default export to be a request handler function or an
// http.Server; a bare named export (`createApp`) does not satisfy that
// contract and fails with "Invalid export ... default export must be a
// function or server." Exporting a ready instance here means this file
// works no matter which of the two Vercel ends up invoking.
export default createApp()
