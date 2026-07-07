# forvado-app-backend

Express API for Forvado (football tournament tracker). Pairs with the Vite frontend in `forvado-app-ui`.

## Stack

Express 5, TypeScript, Prisma v7 (`PrismaPg` driver adapter), Supabase (Postgres + Auth verification + Realtime broadcast), Zod, Vitest.

## Setup

```bash
pnpm install
cp .env.example .env.local   # fill in Supabase + database URLs
pnpm postinstall             # prisma generate (also runs automatically after install)
pnpm dev                     # http://localhost:4000
```

## Environment variables

| Var | Description |
|---|---|
| `SUPABASE_URL` | Supabase project URL |
| `SUPABASE_SECRET_KEY` | Supabase service-role key (verifies bearer tokens, realtime broadcast) |
| `DATABASE_URL` | Pooled Postgres connection (runtime) |
| `DIRECT_URL` | Direct Postgres connection (migrations) |
| `PORT` | HTTP port (default 4000) |
| `CORS_ORIGIN` | Comma-separated list of allowed frontend origins |

## Auth

Stateless Bearer-token auth: the frontend sends `Authorization: Bearer <supabase-access-token>` on every request. `src/middleware/auth.ts`'s `requireAuth` verifies the token against Supabase, finds-or-creates the corresponding `User` row, and attaches it as `req.user`. `requireRole(role)` / `requireAdmin` / `requireTeamOwner` / `requirePlayer` enforce the `PLAYER < TEAM_OWNER < ADMIN` hierarchy. Tournament-scoped writes additionally check `canManageTournament()` (`services/tournaments.ts`) inline — true for ADMIN or an assigned `TournamentCoordinator`.

## Structure

- `src/routes/` — one router per domain (`users`, `teams`, `tournaments`, `matches`, `notifications`), mounted in `src/app.ts`
- `src/services/` — business logic (standings computation, knockout bracket generation, tournament/team helpers)
- `src/middleware/` — auth + error handling (`asyncHandler` wraps async routes so thrown errors reach the global handler)
- `src/lib/` — Prisma client singleton, Supabase admin client, Realtime broadcast helper
- No server-side response caching — the frontend caches via TanStack Query; every route always reads fresh from Postgres.

## Commands

```bash
pnpm dev          # dev server (tsx watch)
pnpm build        # tsc build
pnpm test         # vitest
pnpm db:migrate   # prisma migrate dev
pnpm db:studio    # prisma studio
pnpm db:seed      # seed test data
```

## Deploying to Vercel

`api/index.ts` exports the Express app (via `createApp()`) as a single Vercel serverless function, instead of calling `.listen()` like `src/server.ts` does for local dev. `vercel.json` rewrites every incoming path to that function, so Express's own router handles `/health`, `/api/users`, etc. exactly as it does locally.

1. In the Vercel project settings, set **Root Directory** to this repo's root (`forvado-app-api`, if deploying from a monorepo/workspace checkout).
2. Set these Environment Variables in the Vercel project (Production + Preview): `SUPABASE_URL`, `SUPABASE_SECRET_KEY`, `DATABASE_URL`, `DIRECT_URL`, `CORS_ORIGIN` (set to your deployed frontend's origin, e.g. `https://your-frontend.vercel.app`). Do not rely on `.env.local` — that's gitignored and only used for local dev.
3. `pnpm install` triggers `postinstall` (`prisma generate`) automatically during Vercel's build, so the generated Prisma Client is available when the function bundles.
4. No extra build command is needed — Vercel's Node runtime compiles `api/index.ts` (and everything it imports from `src/`) directly.

`DATABASE_URL` should stay pointed at the Postgres **connection pooler** (port 6543, `pgbouncer=true`), not the direct connection — each serverless invocation may run in its own container, and the pooler is what keeps that from exhausting Postgres's connection limit.
