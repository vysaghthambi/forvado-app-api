/**
 * Seed script — creates test users and teams for local development.
 * Run with: pnpm db:seed
 *
 * Creates:
 *   • 8 TEAM_OWNER users  (fake authIds, won't be able to log in via OAuth)
 *   • 8 Teams, one per owner, with the owner added as CAPTAIN (#1)
 *   • 11 PLAYER members per team (#2–12, positions GK/DEF×3/MID×4/FWD×3)
 */

import { PrismaClient } from '@prisma/client'
import { PrismaPg } from '@prisma/adapter-pg'
import { Pool } from 'pg'
import { config } from 'dotenv'

config({ path: '.env.local' })

const pool = new Pool({ connectionString: process.env.DIRECT_URL ?? process.env.DATABASE_URL })
const adapter = new PrismaPg(pool)
const prisma = new PrismaClient({ adapter })

// ---------------------------------------------------------------------------
// Seed data
// ---------------------------------------------------------------------------

const TEAM_OWNERS = [
  { name: 'Arjun Menon',     email: 'arjun@test.local',    position: 'GK'  as const },
  { name: 'Rahul Krishnan',  email: 'rahul@test.local',    position: 'DEF' as const },
  { name: 'Vishnu Nair',     email: 'vishnu@test.local',   position: 'DEF' as const },
  { name: 'Amal Thomas',     email: 'amal@test.local',     position: 'MID' as const },
  { name: 'Siddharth Raj',   email: 'sidharth@test.local', position: 'MID' as const },
  { name: 'Kiran Pillai',    email: 'kiran@test.local',    position: 'FWD' as const },
  { name: 'Dev Prakash',     email: 'dev@test.local',      position: 'FWD' as const },
  { name: 'Nikhil Suresh',   email: 'nikhil@test.local',   position: 'MID' as const },
]

const TEAMS = [
  { name: 'Red Lions FC',       homeColour: '#CC0000', shortCode: 'RLF' },
  { name: 'Blue Warriors',      homeColour: '#0033CC', shortCode: 'BLW' },
  { name: 'Green Falcons',      homeColour: '#006600', shortCode: 'GRF' },
  { name: 'Golden Eagles',      homeColour: '#FFAA00', shortCode: 'GEA' },
  { name: 'Black Panthers',     homeColour: '#111111', shortCode: 'BLP' },
  { name: 'White Wolves',       homeColour: '#FFFFFF', shortCode: 'WLW' },
  { name: 'Thunder Strikers',   homeColour: '#6600CC', shortCode: 'THS' },
  { name: 'Storm United',       homeColour: '#005577', shortCode: 'STU' },
]

// 11 player slots per team: positions cycle GK / DEF×3 / MID×4 / FWD×3
const PLAYER_POSITIONS: ('GK' | 'DEF' | 'MID' | 'FWD')[] = [
  'GK', 'DEF', 'DEF', 'DEF', 'MID', 'MID', 'MID', 'MID', 'FWD', 'FWD', 'FWD',
]

// Generic first names for seeded players
const PLAYER_FIRST_NAMES = [
  'Suraj', 'Deepak', 'Manoj', 'Arun', 'Vineeth',
  'Rohan', 'Akash', 'Pradeep', 'Akhil', 'Nithin', 'Vivek',
]

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log('🌱  Seeding test data...\n')

  for (let i = 0; i < TEAM_OWNERS.length; i++) {
    const o = TEAM_OWNERS[i]
    const t = TEAMS[i]

    // Upsert owner user (email is @unique — safe to re-run)
    const owner = await prisma.user.upsert({
      where:  { email: o.email },
      update: {},
      create: {
        authId:          `test-auth-${i + 1}`,
        email:           o.email,
        displayName:     o.name,
        position:        o.position,
        jerseyNumber:    1,
        role:            'TEAM_OWNER',
        profileComplete: true,
      },
    })

    // Find-or-create team (name is NOT @unique in schema)
    let team = await prisma.team.findFirst({ where: { name: t.name, deletedAt: null } })
    if (!team) {
      team = await prisma.team.create({
        data: {
          name:                t.name,
          homeColour:          t.homeColour,
          shortCode:           t.shortCode,
          ownerId:             owner.id,
          isAcceptingRequests: false,
        },
      })
    }

    // Upsert CAPTAIN membership for owner (#1)
    await prisma.teamMembership.upsert({
      where:  { teamId_userId: { teamId: team.id, userId: owner.id } },
      update: {},
      create: {
        teamId:      team.id,
        userId:      owner.id,
        role:        'CAPTAIN',
        status:      'ACTIVE',
        jerseyNumber: 1,
      },
    })

    // Add 11 PLAYER members (#2–12)
    for (let j = 0; j < 11; j++) {
      const jerseyNum = j + 2
      const pos       = PLAYER_POSITIONS[j]
      const firstName = PLAYER_FIRST_NAMES[j]
      const email     = `player-${i}-${j}@test.local`
      const name      = `${firstName} (T${i + 1})`

      const player = await prisma.user.upsert({
        where:  { email },
        update: {},
        create: {
          authId:          `test-player-${i}-${j}`,
          email,
          displayName:     name,
          position:        pos,
          jerseyNumber:    jerseyNum,
          role:            'PLAYER',
          profileComplete: true,
        },
      })

      await prisma.teamMembership.upsert({
        where:  { teamId_userId: { teamId: team.id, userId: player.id } },
        update: {},
        create: {
          teamId:      team.id,
          userId:      player.id,
          role:        'PLAYER',
          status:      'ACTIVE',
          jerseyNumber: jerseyNum,
        },
      })
    }

    console.log(`  ✔  ${o.name.padEnd(18)} → ${t.name}  (1 captain + 11 players)`)
  }

  console.log(`\n✅  Done — ${TEAM_OWNERS.length} teams, each with 12 members.`)
  console.log('\nNote: these users have fake authIds and cannot log in via OAuth.')
  console.log('Use your real admin account to manage tournaments with these teams.\n')
}

main()
  .catch((e) => { console.error(e); process.exit(1) })
  .finally(() => prisma.$disconnect())
