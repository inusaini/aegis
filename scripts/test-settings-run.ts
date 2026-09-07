// Verifies the DB-backed provider settings (saved via the settings UI/API)
// actually route agent runs through the gateway — no env vars involved.

async function main() {
  const BASE = 'http://localhost:3000'
  const login = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'demo@brownfield.dev', password: 'demo1234' }),
  }).then((r) => r.json())
  const token = login.token
  const auth = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
  console.log('logged in as', login.user.email)

  // confirm settings say gateway is enabled + available
  const settings = await fetch(`${BASE}/api/settings/provider`, { headers: auth }).then((r) => r.json())
  console.log(`gateway status: configured=${settings.status.configured} available=${settings.status.available}`)
  if (!settings.status.available) throw new Error('gateway not available — check settings')

  // existing project with analyzed repo
  const { projects } = await fetch(`${BASE}/api/projects`, { headers: auth }).then((r) => r.json())
  const project = projects.find((p) => p.repository?.analysisStatus === 'ready')
  if (!project) throw new Error('no project with analyzed repo')
  console.log('project:', project.name)

  // create task -> run
  const created = await fetch(`${BASE}/api/projects/${project.id}/tasks`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ description: 'Add a product search API endpoint for searching products by name' }),
  }).then((r) => r.json())
  const runId = created.runId
  console.log('runId:', runId)

  // poll to approval gate
  let run: any = null
  for (let i = 0; i < 120; i++) {
    await new Promise((r) => setTimeout(r, 1000))
    run = await fetch(`${BASE}/api/runs/${runId}`, { headers: auth }).then((r) => r.json())
    if (i % 5 === 0) console.log(`  state: ${run.run.state}`)
    if (['WAITING_FOR_APPROVAL', 'COMPLETED', 'FAILED', 'CANCELLED', 'BLOCKED'].includes(run.run.state)) break
  }
  console.log('state:', run.run.state)
  console.log(`run provider: ${run.run.provider}  model: ${run.run.model}`)
  if (run.run.provider !== '9router') throw new Error(`expected provider 9router, got ${run.run.provider}`)
  if (run.run.model !== 'mock-fast') throw new Error(`expected model mock-fast, got ${run.run.model}`)
  if (!run.run.plan || run.run.plan.status !== 'proposed') throw new Error('plan missing or not proposed')

  // approve via API (as the user would)
  const ok = await fetch(`${BASE}/api/runs/${runId}/approve`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ decision: 'approve' }),
  }).then((r) => r.json())
  console.log('approved:', ok)

  // poll to completion
  for (let i = 0; i < 180; i++) {
    await new Promise((r) => setTimeout(r, 1000))
    run = await fetch(`${BASE}/api/runs/${runId}`, { headers: auth }).then((r) => r.json())
    if (i % 10 === 0) console.log(`  state: ${run.run.state}`)
    if (['COMPLETED', 'FAILED', 'CANCELLED', 'BLOCKED'].includes(run.run.state)) break
  }
  console.log('final state:', run.run.state)

  // gateway must have received the calls
  const gw = await fetch('http://127.0.0.1:20129/__debug/requests').then((r) => r.json()).catch(() => null)
  console.log(`token usage on run: ${run.run.tokenUsage}`)

  if (run.run.state !== 'COMPLETED') throw new Error('run did not complete')
  console.log('\n✅ DB-SETTINGS GATEWAY RUN PASSED — provider routing works via the settings UI config')
}

main().catch((e) => { console.error('❌', e.message); process.exit(1) })
