import type { NextFunction, Request as ExpressRequest, Response } from 'express'
import { ZodError } from 'zod'

// Express 5's `ParamsDictionary`/`ParsedQs` types allow array values (for
// repeated route/query params), which this app never uses — narrow both to
// plain strings so every route handler gets simple `req.params.x`/`req.query.x`
// typing without per-call-site casts.
export type Request = ExpressRequest<Record<string, string>, any, any, Record<string, string | undefined>>

export function notFoundHandler(_req: Request, res: Response) {
  res.status(404).json({ error: 'Not found' })
}

export function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction) {
  if (err instanceof ZodError) {
    return res.status(400).json({ error: 'Invalid data', issues: err.issues })
  }

  console.error(err)
  res.status(500).json({ error: 'Internal server error' })
}

/** Wraps an async route handler so rejected promises reach errorHandler. */
export function asyncHandler(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>
) {
  return (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(fn(req, res, next)).catch(next)
  }
}
