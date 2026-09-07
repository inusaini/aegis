// End-to-end test of the repository intelligence pipeline against the
// sample brownfield repo: index -> overview -> graph -> retrieval -> impact.
const ROOT = process.cwd().replace(/\\/g, '/') // run from the project root
const IS_WIN = process.platform === 'win32'
process.env.DATABASE_URL = `file:${ROOT}/db/test-intelligence.db`
process.env.NODE_ENV = 'test'

import fs from 'fs'
import path from 'path'

/** Cross-platform command run (Bun execSync assumes /bin/sh on Windows). */
function runCmd(cmd: string) {
  const { spawnSync } = require('child_process') as typeof import('child_process')
  const file = IS_WIN ? (process.env.ComSpec || 'cmd.exe') : '/bin/sh'
  const args = IS_WIN ? ['/d', '/s', '/c', cmd] : ['-c', cmd]
  const res = spawnSync(file, args, {
    cwd: process.cwd(),
    env: { ...process.env, DATABASE_URL: process.env.DATABASE_URL },
    encoding: 'utf8' as const,
    windowsHide: true,
  })
  if (res.error) throw res.error
  if (res.status !== 0) throw new Error(`command failed: ${cmd}\n${(res.stderr || '').slice(0, 500)}`)
}

async function main() {
  runCmd('bun run db:push --schema prisma/schema.prisma')

  const { db } = await import('../src/lib/db')
  const { indexRepository } = await import('../src/server/intelligence/indexer')
  const { RepoGraph } = await import('../src/server/intelligence/graph')
  const { hybridRetrieve } = await import('../src/server/intelligence/retrieval')
  const { analyzeImpact } = await import('../src/server/intelligence/impact')
  const { vectorSearch } = await import('../src/server/intelligence/semantic')

  const REPO = path.join(process.cwd(), 'sample-repos', 'legacy-shop')

  // fresh repository record
  await db.repository.deleteMany({})
  await db.project.deleteMany({})
  await db.user.deleteMany({})
  const user = await db.user.create({ data: { email: 'test@local', name: 'Test', passwordHash: 'x' } })
  const project = await db.project.create({ data: { userId: user.id, name: 'Legacy Shop' } })
  const repo = await db.repository.create({
    data: { projectId: project.id, source: 'sample:legacy-shop', sourceType: 'sample', localPath: REPO },
  })

  // ---- 1. index ----
  const steps: string[] = []
  const result = await indexRepository(repo.id, REPO, (p) => steps.push(`${p.step} (${p.percent}%)`))
  console.log('=== INDEX RESULT ===')
  console.log(JSON.stringify({ files: result.files, symbols: result.symbols, relationships: result.relationships, documents: result.documents, commits: result.commits, durationMs: result.durationMs }))
  console.log('progress steps:', steps.length)

  // ---- 2. overview ----
  const ov = result.overview
  console.log('\n=== OVERVIEW ===')
  console.log('languages:', ov.languages.slice(0, 3).map((l) => `${l.name}:${l.files}`).join(', '))
  console.log('frameworks:', ov.frameworks.join(', '))
  console.log('testFrameworks:', ov.testFrameworks.join(', '))
  console.log('database:', ov.database.detected, '| tables:', ov.database.tables.join(','))
  console.log('services:', ov.services.slice(0, 6).join(', '))
  console.log('entryPoints:', ov.entryPoints.join(', '))
  console.log('summary:', ov.architectureSummary)
  console.log('importantDirs:', ov.importantDirectories.slice(0, 5).map((d) => `${d.path}=${d.purpose}`).join(' | '))

  // ---- 3. graph queries ----
  const g = await RepoGraph.load(repo.id)
  console.log('\n=== GRAPH ===')
  console.log('files:', g.files.size, 'symbols:', g.symbols.size, 'edges:', g.edges.length)
  const importers = g.getImporters('src/services/paymentService.js')
  console.log('importers of paymentService:', importers)
  const callers = g.findSymbol('processRefund').flatMap((s) => g.getCallers(s.qualifiedName))
  console.log('callers of processRefund:', callers)
  const callees = g.findSymbol('createOrder').flatMap((s) => g.getCallees(s.qualifiedName))
  console.log('callees of createOrder:', callees.slice(0, 6))
  console.log('tests of paymentService:', g.getRelatedTests('src/services/paymentService.js'))
  console.log('dbAccess keys:', [...g.dbAccess.keys()])
  console.log('externalDeps of app.js:', g.getDependencies('src/app.js').external)

  // ---- 4. system map ----
  const map = g.systemMap()
  console.log('\n=== SYSTEM MAP ===')
  console.log('nodes:', map.nodes.map((n) => `${n.layer}:${n.label}(${n.meta.files})`).join(', '))
  console.log('edges:', map.edges.map((e) => `${e.source} -[${e.kind}x${e.count}]-> ${e.target}`).join('\n  '))

  // ---- 5. retrieval ----
  console.log('\n=== RETRIEVAL: "Fix the race condition in payment processing" ===')
  const r1 = await hybridRetrieve(repo.id, REPO, 'Fix the race condition in payment processing')
  console.log('relevantFiles:', r1.relevantFiles.slice(0, 10))
  console.log('relevantSymbols:', r1.relevantSymbols.slice(0, 8).map((s) => `${s.kind}:${s.name}@${s.file}`))
  console.log('coverage:', JSON.stringify(r1.coverage))
  console.log('git chunk sample:', r1.chunks.filter((c) => c.source === 'git').slice(0, 2).map((c) => c.title))

  // ---- 6. semantic search ----
  console.log('\n=== SEMANTIC SEARCH: "legacy VMS gateway workaround" ===')
  const hits = await vectorSearch(repo.id, 'legacy VMS gateway workaround INC-2231', 5)
  for (const h of hits) console.log(`  ${h.score.toFixed(3)} [${h.doc.sourceType}] ${h.doc.title}: ${h.doc.content.slice(0, 80).replace(/\n/g, ' ')}`)

  // ---- 7. impact ----
  console.log('\n=== IMPACT: race condition task ===')
  const impact = await analyzeImpact(repo.id, REPO, 'Fix the race condition in payment processing', r1, { graph: g })
  console.log('riskLevel:', impact.riskLevel)
  console.log('rationale:', impact.riskRationale)
  console.log('blastRadius:', JSON.stringify(impact.blastRadius))
  console.log('filesAffected:', impact.filesAffected.slice(0, 8).map((f) => `${f.path} <- ${f.reason.slice(0, 40)}`))
  console.log('databaseChanges:', impact.databaseChanges)
  console.log('apisAffected:', impact.apisAffected)
  console.log('testsAffected:', impact.testsAffected.map((t) => t.path))
  console.log('compatibilityConcerns:', impact.compatibilityConcerns)

  // ---- 8. retrieval for endpoint task ----
  console.log('\n=== RETRIEVAL: "Add a product search API endpoint" ===')
  const r2 = await hybridRetrieve(repo.id, REPO, 'Add a product search API endpoint for searching products by name')
  console.log('relevantFiles:', r2.relevantFiles.slice(0, 10))

  await db.$disconnect()

  // cleanup
  fs.rmSync(path.join(process.cwd(), 'db', 'test-intelligence.db'), { force: true })
  console.log('\n✓ INTELLIGENCE PIPELINE OK')
}

main().catch((e) => {
  console.error('FAILED:', e)
  process.exit(1)
})
