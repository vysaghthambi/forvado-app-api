import { defineConfig } from 'prisma/config'
import { config } from 'dotenv'

// Prisma CLI only reads .env — load .env.local so DATABASE URLs are available
config({ path: '.env.local' })

export default defineConfig({
  schema: 'prisma/schema.prisma',
  datasource: {
    url: process.env.DIRECT_URL!,
  },
})
