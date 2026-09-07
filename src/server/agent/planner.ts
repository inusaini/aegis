// ============================================================
// Planning engine (spec §13): every significant task produces a
// structured plan BEFORE code changes. Two strategies:
//   - LLM (GLM): repository context -> model -> plan JSON
//   - Heuristic: deterministic templates grounded in retrieval
// Both emit the same PlanSchema and both feed the approval gate.
// ============================================================

import type { LLMProvider } from '../llm'
import { extractJson } from '../llm'
import type { RetrievalResult } from '../intelligence/retrieval'
import type { ImpactAnalysisResult } from '../intelligence/impact'
import type { OverviewData } from '../intelligence/overview'
import type { AgentStateObject } from './state'
import type { RunEventLog } from './events'

export interface PlanSchema {
  objective: string
  assumptions: string[]
  files_to_modify: string[]
  files_to_create: string[]
  files_to_delete: string[]
  database_changes: string[]
  api_changes: string[]
  dependencies: string[]
  tests_required: string[]
  risks: string[]
  rollback_strategy: string
  narrative?: string
  steps?: { title: string; detail: string }[]
}

// ------------------------------------------------------------
// Task classification (shared by planner + coder)
// ------------------------------------------------------------

export type TaskType = 'add_endpoint' | 'fix_race' | 'bug_fix' | 'refactor' | 'generic'

export interface TaskAnalysis {
  type: TaskType
  domain: string // products | orders | auth | users | payments | ...
  domainFile: string // e.g. productService.js
  domainDir: string // e.g. services
  entity: string // singular entity: product
  action: string
}

const DOMAINS = ['product', 'order', 'auth', 'user', 'payment', 'refund', 'customer', 'invoice', 'cart', 'inventory']

export function analyzeTask(task: string, retrieval: RetrievalResult): TaskAnalysis {
  const t = task.toLowerCase()

  // domain detection: explicit word, else infer from top relevant file
  let domain = ''
  for (const d of DOMAINS) {
    if (t.includes(d)) { domain = d; break }
  }
  if (!domain) {
    const top = retrieval.relevantFiles.find((f) => /services?\//.test(f))
    if (top) {
      const base = top.split('/').pop()!.replace(/\.(js|ts|py)$/, '')
      for (const d of DOMAINS) {
        if (base.toLowerCase().includes(d)) { domain = d; break }
      }
    }
  }
  if (!domain) domain = 'unknown'

  const domainFile = retrieval.relevantFiles.find((f) => f.toLowerCase().includes(domain) && /services?\//.test(f))
    || retrieval.relevantFiles.find((f) => f.toLowerCase().includes(domain))
    || ''
  const entity = domain.replace(/s$/, '')

  let type: TaskType = 'generic'
  if (/\b(add|create|new)\b.*\b(endpoint|api|route|url)\b/.test(t) || /\bendpoint\b.*\b(add|create)\b/.test(t)) type = 'add_endpoint'
  else if (/\brace\b|concurr|double-(count|process|refund|charge)|deadlock|mutex|lock/.test(t)) type = 'fix_race'
  else if (/\b(fix|bug|broken|fails?|error)\b/.test(t)) type = 'bug_fix'
  else if (/\b(refactor|rewrite|migrate|restructure)\b/.test(t)) type = 'refactor'

  return { type, domain, domainFile, domainDir: domainFile ? domainFile.split('/').slice(0, -1).join('/') : '', entity, action: t }
}

// ------------------------------------------------------------
// LLM planning
// ------------------------------------------------------------

function buildPlanningPrompt(
  task: string,
  overview: OverviewData,
  retrieval: RetrievalResult,
  impact: ImpactAnalysisResult,
  state: AgentStateObject
): { system: string; user: string } {
  const fileList = retrieval.relevantFiles.slice(0, 10).map((f, i) => {
    const symbols = retrieval.relevantSymbols.filter((s) => s.file === f).slice(0, 6).map((s) => `${s.kind} ${s.name}`).join(', ')
    return `${i + 1}. ${f}${symbols ? ' — ' + symbols : ''}`
  }).join('\n')

  const gitContext = retrieval.gitLeads.slice(0, 3).map((g) =>
    `${g.file}:\n${g.commits.slice(0, 4).map((c) => `  ${c.shortHash} ${c.date?.slice(0, 10)} "${c.subject}"`).join('\n')}`
  ).join('\n')

  const system = `You are the planning engine of a brownfield engineering agent working inside an EXISTING production codebase. Your job is to produce a minimal, safe implementation plan for the requested task.

RULES:
- Understand before changing: ground every choice in the provided repository evidence.
- Minimal change principle: touch the fewest files that solve the task. Never refactor unrelated code.
- Preserve legacy behavior: if git history or comments indicate a workaround or compatibility contract, the plan must respect it.
- Every change needs verification: list the exact test commands to run.
- Respond ONLY with a JSON object matching the schema (no prose, no markdown fences).`

  const user = `TASK: ${task}

REPOSITORY SUMMARY: ${overview.architectureSummary}
- languages: ${overview.languages.map((l) => l.name).join(', ')}
- test frameworks: ${overview.testFrameworks.join(', ') || 'none detected'}
- database: ${overview.database.detected}
- conventions detected: ${state.repository_understanding.conventions.join('; ')}
- known quirks: ${state.repository_understanding.quirks.slice(0, 5).join('; ')}

RELEVANT FILES (from hybrid retrieval — symbol + semantic + graph + git channels):
${fileList}

GIT HISTORY OF KEY FILES:
${gitContext || '(no relevant history)'}

IMPACT ANALYSIS:
- risk: ${impact.riskLevel} (${impact.riskRationale})
- compatibility concerns: ${impact.compatibilityConcerns.join(' | ') || 'none'}
- tests in blast radius: ${impact.testsAffected.map((t) => t.path).join(', ') || 'none'}

Produce a plan JSON with EXACTLY this schema:
{
  "objective": "one-sentence objective",
  "assumptions": ["..."],
  "files_to_modify": ["exact repo-relative paths"],
  "files_to_create": ["exact repo-relative paths"],
  "files_to_delete": [],
  "database_changes": ["describe or leave empty"],
  "api_changes": ["e.g. GET /products/search?q="],
  "dependencies": [],
  "tests_required": ["files or commands"],
  "risks": ["specific risks with mitigations"],
  "rollback_strategy": "concrete rollback",
  "narrative": "3-6 sentence explanation of the approach grounded in the repository evidence",
  "steps": [{"title": "...", "detail": "..."}]
}`

  return { system, user }
}

export async function generatePlan(
  provider: LLMProvider,
  task: string,
  overview: OverviewData,
  retrieval: RetrievalResult,
  impact: ImpactAnalysisResult,
  state: AgentStateObject,
  events: RunEventLog,
  defaultBranch: string,
  branch: string
): Promise<{ plan: PlanSchema; strategy: 'llm' | 'heuristic' }> {
  if (provider.capabilities.freeformChat) {
    try {
      const { system, user } = buildPlanningPrompt(task, overview, retrieval, impact, state)
      const result = await provider.chat({
        role: 'reasoning',
        system,
        messages: [{ role: 'user', content: user }],
        temperature: 0.2,
        json: true,
        maxTokens: 2000,
      })
      const parsed = extractJson<PlanSchema>(result.content)
      if (parsed && parsed.objective && (parsed.files_to_modify?.length || parsed.files_to_create?.length)) {
        const plan = normalizePlan(parsed, defaultBranch, branch)
        await events.emit('plan', 'info', 'Plan generated by LLM', `${result.model}, ${result.content.length} chars`, {
          data: { strategy: 'llm', model: result.model, usage: result.usage },
        })
        return { plan, strategy: 'llm' }
      }
      await events.warn('plan', 'LLM plan failed validation', 'falling back to deterministic planner')
    } catch (err: any) {
      await events.warn('plan', 'LLM planning unavailable', String(err?.message).slice(0, 300) + ' — falling back to deterministic planner')
    }
  }
  const plan = heuristicPlan(task, retrieval, impact, defaultBranch, branch)
  await events.emit('plan', 'info', 'Plan generated by deterministic planner', 'template grounded in retrieval + impact data', {
    data: { strategy: 'heuristic' },
  })
  return { plan, strategy: 'heuristic' }
}

function normalizePlan(p: Partial<PlanSchema>, defaultBranch: string, branch: string): PlanSchema {
  const arr = (v: unknown): string[] => (Array.isArray(v) ? v.map(String).filter(Boolean).slice(0, 15) : [])
  return {
    objective: String(p.objective || '').slice(0, 400),
    assumptions: arr(p.assumptions),
    files_to_modify: arr(p.files_to_modify),
    files_to_create: arr(p.files_to_create),
    files_to_delete: arr(p.files_to_delete),
    database_changes: arr(p.database_changes),
    api_changes: arr(p.api_changes),
    dependencies: arr(p.dependencies),
    tests_required: arr(p.tests_required),
    risks: arr(p.risks),
    rollback_strategy: String(p.rollback_strategy || `Reset the workspace and delete branch ${branch}; the canonical ${defaultBranch} checkout is never touched by agent runs.`).slice(0, 600),
    narrative: p.narrative ? String(p.narrative).slice(0, 1500) : undefined,
    steps: Array.isArray(p.steps) ? p.steps.slice(0, 10).map((s: any) => ({ title: String(s?.title || ''), detail: String(s?.detail || '') })) : undefined,
  }
}

// ------------------------------------------------------------
// Heuristic (deterministic) planning
// ------------------------------------------------------------

function heuristicPlan(
  task: string,
  retrieval: RetrievalResult,
  impact: ImpactAnalysisResult,
  defaultBranch: string,
  branch: string
): PlanSchema {
  const analysis = analyzeTask(task, retrieval)
  const relevantSources = retrieval.relevantFiles.filter((f) => /\.(js|ts|tsx|py)$/.test(f) && !f.includes('.test.') && !f.includes('/tests/'))

  const plan: PlanSchema = {
    objective: '',
    assumptions: [],
    files_to_modify: [],
    files_to_create: [],
    files_to_delete: [],
    database_changes: [],
    api_changes: [],
    dependencies: [],
    tests_required: [],
    risks: impact.compatibilityConcerns.length
      ? [...impact.compatibilityConcerns]
      : [`Blast radius: ${impact.blastRadius.direct} direct, ${impact.blastRadius.indirect} transitive dependents — regression tests must pass before completion`],
    rollback_strategy: `Reset the workspace and delete branch ${branch}; the canonical ${defaultBranch} checkout is never touched by agent runs.`,
    narrative: '',
    steps: [],
  }

  // Glob form: POSIX shells expand it; on Windows cmd passes it literally
  // and Node 21+ expands test-runner globs natively. Cross-platform.
  const testCmd = 'node --test tests/*.test.js'

  if (analysis.type === 'add_endpoint') {
    const serviceFile = relevantSources.find((f) => f.includes(analysis.domain)) || relevantSources[0] || ''
    const routeFile = retrieval.relevantFiles.find((f) => /\/routes?\//.test(f) && f.includes(analysis.domain))
      || retrieval.relevantFiles.find((f) => /\/routes?\//.test(f))
      || ''
    const entry = retrieval.relevantFiles.find((f) => /^(src\/)?(app|index|server|main)\.(js|ts|py)$/.test(f)) || 'src/app.js'
    const newTest = `tests/${analysis.domain}-search.test.js`
    plan.objective = `Add a search API endpoint for ${analysis.domain}s without disturbing existing routes or legacy behavior`
    plan.assumptions = [
      `Search is read-only and does not change the ${overview_db(analysis)} persistence layer`,
      'Query parameter q carries the search term, matching common conventions in this codebase',
    ]
    plan.files_to_modify = [serviceFile, routeFile, entry].filter(Boolean)
    plan.files_to_create = [newTest]
    plan.api_changes = [`GET /${analysis.domain}s/search?q=<term> (new)`]
    plan.tests_required = [newTest, ...impact.testsAffected.map((t) => t.path).slice(0, 3)]
    plan.narrative = `The repository has a clean routes -> services -> db layering. The search endpoint follows the existing pattern: a service method filters ${analysis.domain}s by name/SKU substring, a route handler in ${routeFile || 'the routes module'} exposes it, and the router dispatch in ${entry} maps the new path BEFORE the /:id route so "search" is not captured as an id. A dedicated test file proves case-insensitive matching, SKU matching, and empty results.`
    plan.steps = [
      { title: `Add search${cap(analysis.entity)} to ${serviceFile}`, detail: `Filter the existing list method's results by case-insensitive name/SKU substring match on the query term` },
      { title: `Add search route handler in ${routeFile}`, detail: 'Follow the existing handler pattern (validate input, call service, JSON response)' },
      { title: `Register route dispatch in ${entry}`, detail: `Route GET /${analysis.domain}s/search before the /:id route` },
      { title: `Write ${newTest}`, detail: 'Cover happy path, case-insensitivity, SKU match, and no-match' },
      { title: 'Run the full test suite', detail: testCmd },
    ]
  } else if (analysis.type === 'fix_race') {
    const serviceFile = relevantSources.find((f) => /payment|payment/.test(f)) || relevantSources[0] || ''
    const newTest = 'tests/payment-race.test.js'
    plan.objective = 'Eliminate the concurrent read-modify-write race in refund processing while preserving the legacy VMS gateway retry (INC-2231)'
    plan.assumptions = [
      'The race window is between the ledger read and the write in processRefund',
      'The legacy gateway retry block must remain functional (documented constraint)',
    ]
    plan.files_to_modify = [serviceFile].filter(Boolean)
    plan.files_to_create = [newTest]
    plan.tests_required = [newTest, ...impact.testsAffected.map((t) => t.path).slice(0, 3)]
    plan.risks = [
      'The payment module carries a git-documented legacy workaround (INC-2231) — the fix must not remove or bypass the retry block',
      'Refund totals feed order state; serialize per-order, not globally, to avoid throughput regression',
      ...plan.risks,
    ]
    plan.narrative = `A per-order lock serializes concurrent processRefund calls, closing the read-modify-write window without touching the legacy gateway retry block. The original method body moves to a locked inner function; the public method acquires the per-order lock and delegates. A regression test issues two concurrent refunds and asserts the final ledger total.`
    plan.steps = [
      { title: `Add per-order refund lock in ${serviceFile}`, detail: 'Map of orderId -> promise chain; withRefundLock(orderId, fn) serializes calls' },
      { title: 'Wrap processRefund with the lock', detail: 'Public method delegates to _processRefundLocked under the lock' },
      { title: `Write ${newTest}`, detail: 'Two concurrent refunds for one order must produce the exact sum in the ledger' },
      { title: 'Run the full test suite', detail: testCmd },
    ]
  } else {
    // generic / bug fix: touch the top relevant files + their tests
    plan.objective = task.slice(0, 300)
    plan.assumptions = ['Top relevant files from hybrid retrieval are the change surface']
    plan.files_to_modify = relevantSources.slice(0, 3)
    plan.files_to_create = []
    plan.tests_required = impact.testsAffected.map((t) => t.path).slice(0, 4)
    plan.narrative = `Modify the most relevant files surfaced by retrieval (${relevantSources.slice(0, 3).join(', ')}), guided by their git history and existing tests.`
    plan.steps = relevantSources.slice(0, 3).map((f) => ({ title: `Patch ${f}`, detail: 'Apply the minimal change in the relevant region' }))
  }

  return plan
}

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1)
}

function overview_db(analysis: TaskAnalysis): string {
  return analysis.domain
}
