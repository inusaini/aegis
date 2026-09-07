// Seed: demo user + demo project connected to the sample repository.
// Idempotent: safe to run repeatedly.
// Usage (from the project root): bun scripts/seed.ts
const ROOT = process.cwd().replace(/\\/g, '/')
process.env.DATABASE_URL = process.env.DATABASE_URL || `file:${ROOT}/db/custom.db`

async function main() {
  const { db } = await import('../src/lib/db')
  const { hashPassword } = await import('../src/lib/auth')

  const email = 'demo@brownfield.dev'
  let user = await db.user.findUnique({ where: { email } })
  if (!user) {
    user = await db.user.create({
      data: { email, name: 'Demo Developer', passwordHash: hashPassword('demo1234') },
    })
  }

  // a demo project with the sample repository already connected
  let project = await db.project.findFirst({ where: { userId: user.id, name: 'legacy-shop' } })
  if (!project) {
    project = await db.project.create({
      data: {
        userId: user.id,
        name: 'legacy-shop',
        description: 'Sample brownfield repository — 2015-era order management backend with legacy quirks, tests and git history.',
      },
    })
  }
  let repo = await db.repository.findUnique({ where: { projectId: project.id } })
  if (!repo) {
    repo = await db.repository.create({
      data: {
        projectId: project.id,
        source: 'sample:legacy-shop',
        sourceType: 'sample',
        cloneStatus: 'pending',
        analysisStatus: 'pending',
      },
    })
  }

  console.log('seeded:')
  console.log('  user:    demo@brownfield.dev / demo1234')
  console.log(`  project: legacy-shop (${repo.source}, analysis ${repo.analysisStatus})`)
  console.log('  login via the UI, open the project, and trigger repository analysis')
  await db.$disconnect()
}

main().catch((e) => {
  console.error('seed failed:', e)
  process.exit(1)
})
