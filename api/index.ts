import { createApp } from '../src/app.js'

// Vercel serverless entry point. Unlike src/server.ts (used for local dev /
// traditional hosting), this does NOT call .listen() — Vercel's Node.js
// runtime invokes the exported Express app directly as the request handler
// for every incoming request (see vercel.json's catch-all rewrite).
// Env vars are provided by the Vercel project's configured environment
// variables, not .env.local, so no dotenv loading is needed here.
export default createApp()
