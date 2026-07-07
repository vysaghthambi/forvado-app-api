import { config } from 'dotenv'

// Imported first (side-effect only) so env vars are populated before any
// other module (e.g. lib/supabaseAdmin.ts) reads process.env at load time.
config({ path: '.env.local' })
