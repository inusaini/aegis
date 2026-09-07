// E2E test: full agent run against the sample repo with the
// deterministic (heuristic) provider — no LLM required.
// Validates the acceptance workflow: investigate -> impact ->
// plan -> approve -> implement -> verify -> diff -> summary.
const ROOT = process.cwd() // run from the project root, as documented
const IS_WIN = process.platform === 'win32'
process.env.DATABASE_URL = `file:${ROOT}/db/test-agent.db`
process.env.AGENT_PROVIDER = 'heuristic'

import fs from 'fs'
import path from 'path'

/** Cross-platform command run (Bun execSync assumes /bin/sh on Windows). */
function runCmd(cmd: string) {
  const { spawnSync } = require('child_process') as typeof import('child_process')
  const file = IS_WIN ? (process.env.ComSpec || 'cmd.exe') : '/bin/sh'
  const args = IS_WIN ? ['/d', '/s', '/c', cmd] : ['-c', cmd]
  const res = spawnSync(file, args, {
    cwd: ROOT,
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
  const engine = await import('../src/server/agent/engine')

  // clean slate
  for (const model of ['agentEvent', 'testRun', 'change', 'plan', 'agentRun', 'task', 'memory', 'document', 'relationship', 'symbol', 'file', 'repositoryAnalysis', 'repository', 'project', 'user'] as const) {
    await (db as any)[model].deleteMany({})
  }
  // wipe agent data dirs
  fs.rmSync(path.join(ROOT, '.agent-data'), { recursive: true, force: true })

  const user = await db.user.create({ data: { email: 'e2e@local', name: 'E2E', passwordHash: 'x' } })
  const project = await db.project.create({ data: { userId: user.id, name: 'Legacy Shop E2E' } })
  const repo = await db.repository.create({
    data: { projectId: project.id, source: 'sample:legacy-shop', sourceType: 'sample', localPath: '/nonexistent', analysisStatus: 'pending' },
  })

  const TASK_DESC = process.env.TASK || 'Add a product search API endpoint for searching products by name'
  const task = await db.task.create({
    data: { projectId: project.id, userId: user.id, title: TASK_DESC.slice(0, 60), description: TASK_DESC },
  })

  console.log('--- starting run ---')
  const runId = await engine.startRun(task.id)
  console.log('runId:', runId)

  // poll until WAITING_FOR_APPROVAL or terminal
  let state = ''
  for (let i = 0; i < 90; i++) {
    await sleep(1000)
    const run = await db.agentRun.findUnique({ where: { id: runId }, select: { state: true, error: true } })
    state = run?.state || ''
    if (i % 5 === 0) console.log(`  state: ${state}`)
    if (state === 'WAITING_FOR_APPROVAL' || ['COMPLETED', 'FAILED', 'CANCELLED', 'BLOCKED'].includes(state)) break
  }
  console.log('paused at state:', state)

  if (state !== 'WAITING_FOR_APPROVAL') {
    const events = await db.agentEvent.findMany({ where: { runId }, orderBy: { seq: 'asc' } })
    for (const e of events) console.log(`  [${e.phase}/${e.type}] ${e.title} — ${e.detail.slice(0, 120)}`)
    const run = await db.agentRun.findUnique({ where: { id: runId } })
    console.error('FAILED to reach approval gate. error:', run?.error)
    throw new Error('did not reach WAITING_FOR_APPROVAL')
  }

  // show the plan
  const plan = await db.plan.findUnique({ where: { runId } })
  console.log('\n--- PLAN ---')
  console.log('objective:', plan?.objective)
  console.log('files_to_modify:', plan?.filesToModify)
  console.log('files_to_create:', plan?.filesToCreate)
  console.log('api_changes:', plan?.apiChanges)
  console.log('risks:', plan?.risks?.slice(0, 300))

  // approve
  console.log('\n--- approving ---')
  await db.plan.update({ where: { runId }, data: { status: 'approved', approvedAt: new Date(), approvedBy: user.id } })
  await engine.resumeRun(runId)

  // poll until terminal
  for (let i = 0; i < 120; i++) {
    await sleep(1000)
    const run = await db.agentRun.findUnique({ where: { id: runId }, select: { state: true, error: true } })
    state = run?.state || ''
    if (i % 5 === 0) console.log(`  state: ${state}`)
    if (['COMPLETED', 'FAILED', 'CANCELLED', 'BLOCKED'].includes(state)) break
  }
  console.log('final state:', state)

  // print the event timeline
  const events = await db.agentEvent.findMany({ where: { runId }, orderBy: { seq: 'asc' } })
  console.log('\n--- EVENT TIMELINE ---')
  for (const e of events) console.log(`  ${String(e.seq).padStart(3)} [${e.phase}/${e.type}] ${e.title} — ${e.detail.slice(0, 110)}`)

  // changes + test runs + final result
  const changes = await db.change.findMany({ where: { runId } })
  console.log('\n--- CHANGES ---')
  for (const c of changes) console.log(`  ${c.changeType} ${c.file} (+${c.additions}/-${c.deletions})`)

  const testRuns = await db.testRun.findMany({ where: { runId }, orderBy: { startedAt: 'asc' } })
  console.log('\n--- TEST RUNS ---')
  for (const t of testRuns) console.log(`  ${t.kind} [${t.status}] fix=${t.fixAttempt} class=${t.classification} cmd=${t.command} — ${t.summary.slice(0, 100)}`)

  const run = await db.agentRun.findUnique({ where: { id: runId } })
  const stateData = JSON.parse(run?.stateData || '{}')
  console.log('\n--- FINAL RESULT ---')
  console.log(stateData.final_result?.summary)
  console.log('verified:', JSON.stringify(stateData.final_result?.verified, null, 1))

  // diff of first change
  if (changes.length) {
    console.log('\n--- DIFF SAMPLE (first change) ---')
    console.log(changes[0].diff.slice(0, 1500))
  }

  await db.$disconnect()
  if (state !== 'COMPLETED') {
    console.error('RUN DID NOT COMPLETE. error:', run?.error)
    process.exit(1)
  }
  console.log('\n✓ AGENT E2E OK')
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms))
}

main().catch((e) => {
  console.error('E2E FAILED:', e)
  process.exit(1)
})
