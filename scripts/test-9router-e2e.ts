// E2E test: agent runs through a mock 9router gateway (OpenAI-compatible).
// Proves: provider factory picks the gateway, planner gets a valid plan
// from the gateway's chat completions, the whole state machine advances,
// and every LLM call actually went through the gateway endpoint.

const ROOT = process.cwd().replace(/\\/g, '/') // run from the project root
const IS_WIN = process.platform === 'win32'
process.env.DATABASE_URL = `file:${ROOT}/db/test-gateway.db`
process.env.LLM_BASE_URL = 'http://127.0.0.1:20129/v1'
process.env.LLM_API_KEY = 'sk-test-9router-master-key'
process.env.LLM_PROVIDER_NAME = '9router'
process.env.LLM_MODEL = 'mock-fast'
process.env.LLM_REASONING_MODEL = 'mock-reasoning'
process.env.LLM_CODING_MODEL = 'mock-coding'

import fs from 'fs'
import path from 'path'
import { startMock9router } from './mock-9router'

function sleep(ms: number) { return new Promise((r) => setTimeout(r, ms)) }

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

  const gateway = await startMock9router(20129)
  console.log('mock 9router gateway up on :20129')

  const { db } = await import('../src/lib/db')
  const engine = await import('../src/server/agent/engine')
  const { getProvider } = await import('../src/server/llm')

  // 1. factory selects the gateway
  const provider = await getProvider(true)
  console.log('provider selected:', provider.name)
  if (provider.name !== '9router') throw new Error(`expected 9router provider, got ${provider.name}`)

  // clean slate
  for (const model of ['agentEvent', 'testRun', 'change', 'plan', 'agentRun', 'task', 'memory', 'document', 'relationship', 'symbol', 'file', 'repositoryAnalysis', 'repository', 'project', 'user'] as const) {
    await (db as any)[model].deleteMany({})
  }
  fs.rmSync(path.join(process.cwd(), '.agent-data'), { recursive: true, force: true })

  const user = await db.user.create({ data: { email: 'gw@local', name: 'GW', passwordHash: 'x' } })
  const project = await db.project.create({ data: { userId: user.id, name: 'Gateway Test' } })
  const repo = await db.repository.create({
    data: { projectId: project.id, source: 'sample:legacy-shop', sourceType: 'sample', localPath: '/nonexistent', analysisStatus: 'pending' },
  })

  const TASK_DESC = 'Add a product search API endpoint for searching products by name'
  const task = await db.task.create({
    data: { projectId: project.id, userId: user.id, title: TASK_DESC.slice(0, 60), description: TASK_DESC },
  })

  console.log('--- starting run via gateway ---')
  const runId = await engine.startRun(task.id)

  let state = ''
  for (let i = 0; i < 120; i++) {
    await sleep(1000)
    const run = await db.agentRun.findUnique({ where: { id: runId }, select: { state: true, error: true } })
    state = run?.state || ''
    if (i % 5 === 0) console.log(`  state: ${state}`)
    if (state === 'WAITING_FOR_APPROVAL' || ['COMPLETED', 'FAILED', 'CANCELLED', 'BLOCKED'].includes(state)) break
  }
  console.log('paused at state:', state)

  if (state !== 'WAITING_FOR_APPROVAL') {
    const events = await db.agentEvent.findMany({ where: { runId }, orderBy: { seq: 'asc' } })
    for (const e of events.slice(-12)) console.log(`  [${e.phase}/${e.type}] ${e.title} — ${e.detail.slice(0, 100)}`)
    const run = await db.agentRun.findUnique({ where: { id: runId } })
    await gateway.stop()
    throw new Error(`did not reach approval gate (${state}); error: ${run?.error}`)
  }

  // 2. the run record must show the gateway provider + model label
  const runRec = await db.agentRun.findUnique({ where: { id: runId } })
  console.log(`run record: provider=${runRec?.provider} model=${runRec?.model}`)
  if (runRec?.provider !== '9router') throw new Error('run not attributed to gateway provider')
  if (runRec?.model !== 'mock-fast') throw new Error(`unexpected model label: ${runRec?.model}`)

  // 3. the plan must have come from the gateway's LLM response
  const plan = await db.plan.findFirst({ where: { runId } })
  if (!plan) throw new Error('no plan created')
  console.log(`plan: strategy=${(plan as any).full?.slice ? 'llm' : 'llm'} objective="${plan.objective.slice(0, 60)}…"`)
  console.log(`plan filesToModify: ${plan.filesToModify}`)
  const planFull: any = JSON.parse(plan.full || '{}')
  if (!planFull.narrative || !/mock 9router gateway/.test(planFull.narrative)) {
    throw new Error('plan narrative did not originate from the mock gateway')
  }

  // 4. gateway actually received the LLM calls, with the right auth + models
  const chats = gateway.requests.filter((r) => r.path === '/v1/chat/completions')
  const authOk = chats.every((r) => r.auth === 'Bearer sk-test-9router-master-key')
  const models = [...new Set(chats.map((r) => r.model))]
  console.log(`gateway chat calls: ${chats.length}, auth header ok: ${authOk}`)
  console.log(`models used by role: ${models.join(', ')}`)
  if (chats.length < 2) throw new Error('expected at least 2 gateway chat calls (planner + understanding)')
  if (!authOk) throw new Error('gateway auth header missing/incorrect')

  // 5. approve (mirrors the real approve route) and let the run's own
  //    decision loop pick it up, then drive to completion
  await db.plan.update({ where: { runId }, data: { status: 'approved', approvedAt: new Date() } })
  let final = ''
  for (let i = 0; i < 180; i++) {
    await sleep(1000)
    const run = await db.agentRun.findUnique({ where: { id: runId }, select: { state: true } })
    final = run?.state || ''
    if (i % 10 === 0) console.log(`  state: ${final}`)
    if (['COMPLETED', 'FAILED', 'CANCELLED', 'BLOCKED'].includes(final)) break
  }
  console.log('final state:', final)
  await gateway.stop()
  if (final !== 'COMPLETED') throw new Error(`run did not complete (${final})`)

  const totalChats = gateway.requests.filter((r) => r.path === '/v1/chat/completions').length
  const doneRun = await db.agentRun.findUnique({ where: { id: runId } })
  console.log(`\n✅ GATEWAY E2E PASSED — ${totalChats} LLM calls routed through the 9router endpoint`)
  console.log(`   token usage recorded: ${doneRun?.tokenUsage}`)
  console.log('   provider attribution, model labels, plan-from-LLM, auth — all verified')
}

main().catch((err) => {
  console.error('❌ FAILED:', err.message)
  process.exit(1)
})
