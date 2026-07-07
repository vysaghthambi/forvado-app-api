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
