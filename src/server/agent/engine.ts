// ============================================================
// Orchestrator (spec §8, §9): owns the agent workflow state
// machine and drives the specialized engines:
//
//   Repository Intelligence → Planning Engine → Coding Agent
//   → Verification Engine, all through the tool gateway into
//   an isolated workspace.
//
// State is persisted after every transition, so any run can be
// inspected or resumed. Approvals pause the loop; the approve
// API (or the startup recovery pass) resumes it.
// ============================================================

import { db } from '@/lib/db'
import fs from 'fs'
import { getProvider, providerModelLabel } from '../llm'
import type { LLMProvider } from '../llm'
import * as workspace from '../sandbox/workspace'
import { indexRepository } from '../intelligence/indexer'
import { RepoGraph } from '../intelligence/graph'
import { hybridRetrieve, type RetrievalResult } from '../intelligence/retrieval'
import { analyzeImpact, type ImpactAnalysisResult } from '../intelligence/impact'
import { generatePlan, type PlanSchema } from './planner'
import { implement } from './coder'
import { verifyAndRepair, finalReview, detectCommands, type VerificationResult, type FinalReview } from './verifier'
import { RunEventLog } from './events'
import { initialStateObject, isTerminal, type AgentStateObject } from './state'
import type { AgentState } from '@/lib/types'

// in-memory registry of live runs
const liveRuns = new Map<string, { cancelled: boolean }>()

export function isRunLive(runId: string): boolean {
  return liveRuns.has(runId)
}

export function cancelRun(runId: string): boolean {
  const entry = liveRuns.get(runId)
  if (!entry) return false
  entry.cancelled = true
  return true
}

async function setState(runId: string, state: AgentState, stateData?: AgentStateObject) {
  await db.agentRun.update({
    where: { id: runId },
    data: { state, ...(stateData ? { stateData: JSON.stringify(stateData) } : {}) },
  })
}

async function getState(runId: string): Promise<{ state: string; stateData: AgentStateObject }> {
  const run = await db.agentRun.findUniqueOrThrow({ where: { id: runId } })
  let stateData: AgentStateObject
  try { stateData = JSON.parse(run.stateData) } catch { stateData = initialStateObject('', { id: '', source: '', branch: '', defaultBranch: '', path: '' }) }
  return { state: run.state, stateData }
}

// ------------------------------------------------------------
// Run lifecycle
// ------------------------------------------------------------

export async function startRun(taskId: string): Promise<string> {
  const task = await db.task.findUniqueOrThrow({
    where: { id: taskId },
    include: { project: { include: { repository: true } } },
  })
  const repo = task.project.repository
  if (!repo) throw new Error('project has no connected repository')

  const run = await db.agentRun.create({
    data: {
      taskId,
      projectId: task.projectId,
      state: 'CREATED',
      stateData: JSON.stringify(initialStateObject(task.description, {
        id: repo.id,
        source: repo.source,
        branch: repo.branch || repo.defaultBranch,
        defaultBranch: repo.defaultBranch,
        path: repo.localPath,
      })),
      mode: 'autonomous',
    },
  })
  await db.task.update({ where: { id: taskId }, data: { status: 'in_progress' } })

  // fire and forget — the loop persists everything it does
  void executeRun(run.id).catch(async (err) => {
    console.error(`[agent] run ${run.id} crashed:`, err)
    try {
      await db.agentRun.update({
        where: { id: run.id },
        data: { state: 'FAILED', error: String(err?.message || err).slice(0, 1000), finishedAt: new Date() },
      })
    } catch { /* ignore */ }
  })
  return run.id
}

export async function resumeRun(runId: string): Promise<boolean> {
  const run = await db.agentRun.findUnique({ where: { id: runId }, include: { plan: true } })
  if (!run) return false
  if (run.state !== 'WAITING_FOR_APPROVAL') return false
  if (run.plan?.status !== 'approved') return false
  if (liveRuns.has(runId)) return true // already resumed
  void executeRun(runId, { resumeFromApproval: true }).catch(async (err) => {
    console.error(`[agent] resumed run ${runId} crashed:`, err)
    try {
      await db.agentRun.update({
        where: { id: runId },
        data: { state: 'FAILED', error: String(err?.message || err).slice(0, 1000), finishedAt: new Date() },
      })
    } catch { /* ignore */ }
  })
  return true
}

/** Mark runs that died with a server restart (non-terminal, not approval-gated) as BLOCKED. */
export async function recoverStaleRuns(): Promise<number> {
  const stale = await db.agentRun.findMany({
    where: { state: { in: ['CREATED', 'DISCOVERING', 'UNDERSTANDING', 'IMPACT_ANALYSIS', 'PLANNING', 'IMPLEMENTING', 'VERIFYING', 'FIXING', 'FINAL_REVIEW'] } },
  })
  for (const run of stale) {
    if (liveRuns.has(run.id)) continue
    await db.agentRun.update({
      where: { id: run.id },
      data: { state: 'BLOCKED', error: 'run interrupted by server restart; create a new run to retry', finishedAt: new Date() },
    })
  }
  // resume approval-gated runs whose plans were approved while the server was down
  const waiting = await db.agentRun.findMany({ where: { state: 'WAITING_FOR_APPROVAL' }, include: { plan: true } })
  for (const run of waiting) {
    if (run.plan?.status === 'approved') await resumeRun(run.id)
  }
  return stale.length
}

// ------------------------------------------------------------
// The state machine loop
// ------------------------------------------------------------

async function executeRun(runId: string, opts: { resumeFromApproval?: boolean } = {}) {
  const entry = { cancelled: false }
  liveRuns.set(runId, entry)
  const events = new RunEventLog(runId)

  try {
    const run = await db.agentRun.findUniqueOrThrow({ where: { id: runId }, include: { task: true, plan: true } })
    const task = run.task
    const project = await db.project.findUniqueOrThrow({ where: { id: run.projectId }, include: { repository: true } })
    const repo = project.repository
    if (!repo) throw new Error('project has no connected repository')

    const provider = await getProvider()
    await db.agentRun.update({ where: { id: runId }, data: { provider: provider.name, model: providerModelLabel(provider) } })
    await events.emit('system', 'info', `Agent run started`, `task: ${task.title}`, {
      data: { provider: provider.name, capabilities: provider.capabilities },
    })

    // ------- repository materialization + indexing -------
    let repoPath = repo.localPath
    let analysisReady = repo.analysisStatus === 'ready'
    if (!analysisReady || !fs.existsSync(repoPath)) {
      await setState(runId, 'DISCOVERING')
      await events.status('repository', 'Materializing repository', `${repo.sourceType}: ${repo.source}`)
      const materialized = await workspace.materializeRepository(repo.id, repo.source, repo.sourceType)
      repoPath = materialized.path
      await db.repository.update({ where: { id: repo.id }, data: { localPath: repoPath, cloneStatus: 'ready', branch: materialized.branch } })

      await events.status('repository', 'Indexing repository', 'files, symbols, relationships, documents, git history')
      await db.repository.update({ where: { id: repo.id }, data: { analysisStatus: 'indexing' } })
      const result = await indexRepository(repo.id, repoPath, (p) => {
        void events.emit('repository', 'status', p.step, `${p.percent}%`)
      })
      await events.success('repository', 'Repository indexed',
        `${result.files} files, ${result.symbols} symbols, ${result.relationships} relationships, ${result.documents} documents, ${result.commits} commits (${Math.round(result.durationMs / 100) / 10}s)`)
      analysisReady = true
    }

    if (entry.cancelled) return await finishCancelled(runId)

    const graph = await RepoGraph.load(repo.id)

    // ------- DISCOVERING: hybrid retrieval -------
    if (!opts.resumeFromApproval) {
      await setState(runId, 'DISCOVERING')
      await events.status('investigation', 'Investigating repository', 'hybrid retrieval: semantic + keyword + symbol + reference + graph + git + tests')
      const retrieval = await hybridRetrieve(repo.id, repoPath, task.description)

      const { stateData } = await getState(runId)
      stateData.relevant_components = {
        files: retrieval.relevantFiles.slice(0, 12).map((f, i) => ({
          path: f,
          score: Math.round((10 - i) * 10) / 10,
          reason: (retrieval.chunks.find((c) => c.path === f)?.reason) || 'retrieval match',
        })),
        symbols: retrieval.relevantSymbols.slice(0, 20).map((s) => ({ qualifiedName: s.qualifiedName, kind: s.kind })),
        retrieval: retrieval.coverage,
      }
      stateData.repository = { ...stateData.repository, path: repoPath }
      await setState(runId, 'DISCOVERING', stateData)

      await events.success('investigation', `${retrieval.relevantFiles.length} relevant files identified`,
        retrieval.relevantFiles.slice(0, 8).join(', '))
      await events.success('investigation', `${retrieval.relevantSymbols.length} relevant symbols discovered`,
        retrieval.relevantSymbols.slice(0, 6).map((s) => s.name).join(', '))
      await events.emit('investigation', 'info', 'Retrieval channel coverage', JSON.stringify(retrieval.coverage))

      // ------- UNDERSTANDING -------
      await setState(runId, 'UNDERSTANDING')
      await events.status('investigation', 'Understanding the relevant architecture', 'combining overview, symbols, git history and documents')
      const analysisRow = await db.repositoryAnalysis.findUnique({ where: { repositoryId: repo.id } })
      const overview = analysisRow ? JSON.parse(analysisRow.overview) : { architectureSummary: '', languages: [], frameworks: [], testFrameworks: [], database: { detected: '' }, entryPoints: [], services: [], importantDirectories: [], dependencies: [], testFrameworks: [] }

      // conventions + quirks from README/docs/git
      const conventions = extractConventions(overview, retrieval)
      const quirks = extractQuirks(retrieval)

      // git history for key files
      const gitLeads = retrieval.gitLeads.slice(0, 4)
      for (const lead of gitLeads) {
        const legacyCommit = lead.commits.find((c) => /HACK|workaround|DO NOT|legacy|compat/i.test(c.subject))
        if (legacyCommit) {
          await events.emit('investigation', 'success', `Git history inspected: ${lead.file}`,
            `${legacyCommit.shortHash} "${legacyCommit.subject}" (${legacyCommit.date?.slice(0, 10)}) — historical constraint recorded`)
        }
      }

      stateData.repository_understanding = {
        overview: {
          languages: overview.languages?.map((l: any) => l.name) || [],
          frameworks: overview.frameworks || [],
          testFrameworks: overview.testFrameworks || [],
          database: overview.database?.detected || '',
          entryPoints: overview.entryPoints || [],
          services: overview.services || [],
        },
        architectureSummary: overview.architectureSummary || '',
        conventions,
        quirks,
      }
      stateData.historical_context = gitLeads.flatMap((g) =>
        g.commits.slice(0, 3).map((c) => ({ file: g.file, commitHash: c.shortHash, subject: c.subject, relevance: legacyRelevance(c) }))
      ).slice(0, 12)
      stateData.dependencies = graph.getDependencies(retrieval.relevantFiles[0] || '') || { local: [], external: [] }
      await setState(runId, 'UNDERSTANDING', stateData)

      // LLM understanding narrative (focused, evidence-grounded)
      if (provider.capabilities.freeformChat) {
        try {
          const narrative = await provider.chat({
            role: 'reasoning',
            system: `You are the repository-understanding engine of a brownfield agent. Given a task and repository evidence, write a concise (max 150 words) factual summary of how the relevant part of the system works and what must be respected when changing it. Only state facts supported by the evidence. No chain-of-thought, just the summary.`,
            messages: [{
              role: 'user',
              content: `TASK: ${task.description}\n\nREPO SUMMARY: ${overview.architectureSummary}\nRELEVANT FILES: ${retrieval.relevantFiles.slice(0, 8).join(', ')}\nKEY SYMBOLS: ${retrieval.relevantSymbols.slice(0, 10).map((s) => s.name).join(', ')}\nGIT HISTORY:\n${gitLeads.map((g) => g.commits.slice(0, 2).map((c) => `${c.shortHash} ${c.subject}`).join('\n')).join('\n')}\nKNOWN QUIRKS: ${quirks.join('; ')}`,
            }],
            temperature: 0.2,
            maxTokens: 400,
          })
          stateData.repository_understanding.architectureSummary = narrative.content.slice(0, 900)
          await setState(runId, 'UNDERSTANDING', stateData)
          await events.emit('investigation', 'info', 'Focused understanding composed', narrative.content.slice(0, 300), { data: { model: narrative.model } })
        } catch (err: any) {
          await events.warn('investigation', 'LLM understanding unavailable', String(err?.message).slice(0, 200))
        }
      }
      await events.success('investigation', 'Repository understanding complete', stateData.repository_understanding.architectureSummary.slice(0, 250))

      // ------- IMPACT ANALYSIS -------
      await setState(runId, 'IMPACT_ANALYSIS')
      await events.status('impact', 'Building impact analysis', 'traversing the reverse dependency graph from relevant files')
      const impact = await analyzeImpact(repo.id, repoPath, task.description, retrieval, { graph })
      stateData.impact_analysis = {
        riskLevel: impact.riskLevel,
        rationale: impact.riskRationale,
        blastRadius: impact.blastRadius,
        compatibilityConcerns: impact.compatibilityConcerns,
        filesAffected: impact.filesAffected,
        servicesAffected: impact.servicesAffected,
        apisAffected: impact.apisAffected,
        databaseChanges: impact.databaseChanges,
        testsAffected: impact.testsAffected,
        evidence: impact.evidence,
      }
      stateData.impact_files = undefined
      stateData.risks = impact.compatibilityConcerns.slice(0, 6)
      await setState(runId, 'IMPACT_ANALYSIS', stateData)
      await events.emit('impact', impact.riskLevel === 'CRITICAL' || impact.riskLevel === 'HIGH' ? 'warning' : 'info',
        `Impact analysis completed — risk ${impact.riskLevel}`, impact.riskRationale, { data: { impact } })
      if (impact.compatibilityConcerns.length) {
        await events.warn('impact', `${impact.compatibilityConcerns.length} compatibility concern(s)`, impact.compatibilityConcerns.join(' | ').slice(0, 500))
      }

      // ------- PLANNING -------
      await setState(runId, 'PLANNING')
      await events.status('plan', 'Generating implementation plan', 'grounded in retrieval + impact evidence')
      const { plan, strategy } = await generatePlan(provider, task.description, overview, retrieval, impact, stateData, events, repo.defaultBranch, `${workspace.branchNameFor(task.title)}-${runId.slice(-6)}`)
      stateData.plan = {
        objective: plan.objective,
        files_to_modify: plan.files_to_modify,
        files_to_create: plan.files_to_create,
        tests: plan.tests_required,
        generated_by: strategy,
      }
      stateData.approval_status = 'pending'
      stateData.assumptions = plan.assumptions
      await setState(runId, 'PLANNING', stateData)

      await db.plan.create({
        data: {
          runId,
          status: 'proposed',
          objective: plan.objective,
          assumptions: JSON.stringify(plan.assumptions),
          filesToModify: JSON.stringify(plan.files_to_modify),
          filesToCreate: JSON.stringify(plan.files_to_create),
          filesToDelete: JSON.stringify(plan.files_to_delete),
          databaseChanges: JSON.stringify(plan.database_changes),
          apiChanges: JSON.stringify(plan.api_changes),
          dependencies: JSON.stringify(plan.dependencies),
          testsRequired: JSON.stringify(plan.tests_required),
          risks: JSON.stringify(plan.risks),
          rollbackStrategy: plan.rollback_strategy,
          full: JSON.stringify({ narrative: plan.narrative || '', steps: plan.steps || [] }),
        },
      })

      // ------- WAITING FOR APPROVAL -------
      await setState(runId, 'WAITING_FOR_APPROVAL', stateData)
      await events.emit('approval', 'approval', 'Plan ready — human approval required', `risk ${impact.riskLevel}: ${plan.objective}`, {
        data: { riskLevel: impact.riskLevel, filesToModify: plan.files_to_modify, filesToCreate: plan.files_to_create },
      })

      // poll for the decision (robust across restarts)
      const decision = await waitForDecision(runId, entry, 24 * 3600_000)
      if (entry.cancelled) return await finishCancelled(runId)
      if (decision !== 'approved') {
        stateData.approval_status = 'rejected'
        await setState(runId, 'CANCELLED', stateData)
        await db.task.update({ where: { id: task.id }, data: { status: 'cancelled' } })
        await events.emit('approval', 'error', 'Plan rejected by user', 'run cancelled; no changes were made')
        await db.agentRun.update({ where: { id: runId }, data: { finishedAt: new Date() } })
        return
      }
      stateData.approval_status = 'approved'
      await setState(runId, 'IMPLEMENTING', stateData)
      await events.success('approval', 'Plan approved by user', 'proceeding to isolated implementation')
    }

    if (entry.cancelled) return await finishCancelled(runId)

    // ------- IMPLEMENTING -------
    const planRow = await db.plan.findUniqueOrThrow({ where: { runId } })
    const plan: PlanSchema = {
      objective: planRow.objective,
      assumptions: JSON.parse(planRow.assumptions || '[]'),
      files_to_modify: JSON.parse(planRow.filesToModify || '[]'),
      files_to_create: JSON.parse(planRow.filesToCreate || '[]'),
      files_to_delete: JSON.parse(planRow.filesToDelete || '[]'),
      database_changes: JSON.parse(planRow.databaseChanges || '[]'),
      api_changes: JSON.parse(planRow.apiChanges || '[]'),
      dependencies: JSON.parse(planRow.dependencies || '[]'),
      tests_required: JSON.parse(planRow.testsRequired || '[]'),
      risks: JSON.parse(planRow.risks || '[]'),
      rollback_strategy: planRow.rollbackStrategy,
    }

    await setState(runId, 'IMPLEMENTING')
    // unique branch per run — a retried task gets its own branch instead of colliding
    const branch = `${workspace.branchNameFor(task.title)}-${runId.slice(-6)}`
    await events.status('implementation', 'Creating isolated workspace', `git worktree on branch ${branch}`)
    const ws = workspace.createWorkspace(runId, repoPath, branch)
    await db.agentRun.update({ where: { id: runId }, data: { branch: ws.branch, workspacePath: ws.path } })
    const { stateData } = await getState(runId)
    stateData.branch = ws.branch
    await setState(runId, 'IMPLEMENTING', stateData)

    const retrieval = await hybridRetrieve(repo.id, repoPath, task.description)
    void retrieval

    const toolCtx = {
      runId,
      repositoryId: repo.id,
      repoPath,
      workspacePath: ws.path,
      graph,
      events,
    }

    const outcome = await implement(provider, toolCtx as any, task.description, plan, retrieval, events)
    if (!outcome.ok) {
      await events.error('implementation', 'Implementation failed', outcome.patchLog.slice(0, 500))
      await setState(runId, 'FAILED')
      await db.agentRun.update({ where: { id: runId }, data: { error: 'implementation failed: ' + outcome.patchLog.slice(0, 500), finishedAt: new Date() } })
      await db.task.update({ where: { id: task.id }, data: { status: 'failed' } })
      return
    }
    await events.success('implementation', 'Changes applied in isolated workspace', `${outcome.filesChanged.length} file(s): ${outcome.filesChanged.join(', ')}`)

    // ------- VERIFYING (with repair loop) -------
    await setState(runId, 'VERIFYING')
    const verification = await verifyAndRepair(provider, toolCtx as any, plan, events)

    // ------- FINAL REVIEW -------
    await setState(runId, 'FINAL_REVIEW')
    await events.status('review', 'Final review', 'diff inspection, security scan, unintended-change detection')
    const changedFiles = workspace.workspaceChangedFiles(ws.path)
    const review = finalReview(changedFiles, plan)

    // persist Change rows
    await db.change.deleteMany({ where: { runId } })
    for (const f of changedFiles) {
      await db.change.create({
        data: {
          runId,
          file: f.path,
          changeType: f.changeType,
          additions: f.additions,
          deletions: f.deletions,
          diff: f.diff.slice(0, 50000),
        },
      })
    }

    const commands = detectCommands(repoPath)
    const verified = buildVerifiedList(verification, commands)
    const finalSummary = composeFinalSummary({
      task: task.description,
      plan,
      verification,
      review,
      branch: ws.branch,
      provider: provider.name,
    })

    stateData.changes = changedFiles.map((f) => ({ file: f.path, changeType: f.changeType, additions: f.additions, deletions: f.deletions }))
    stateData.tests = verification.runs.map((r) => ({ kind: r.kind, command: r.command, status: r.status, fixAttempt: r.fixAttempt }))
    stateData.failures = verification.runs.filter((r) => r.status !== 'passed').map((r) => ({ kind: r.kind, summary: r.summary.slice(0, 200), classification: r.classification, fixed: false }))
    stateData.final_result = {
      summary: finalSummary,
      verified,
      nextSteps: [
        `Review the diff and run POST /api/runs/${runId}/commit to create a git commit on branch ${ws.branch}`,
        'Create a pull request from the agent branch (GitHub integration point)',
      ],
      branch: ws.branch,
    }
    stateData.repository = { ...stateData.repository, path: repoPath }
    await setState(runId, 'FINAL_REVIEW', stateData)

    if (review.securityFindings.length) {
      await events.warn('review', 'Security-sensitive content detected in changes', review.securityFindings.join(' | ').slice(0, 400))
    }
    if (review.unintendedChanges.length) {
      await events.warn('review', 'Changes outside the approved plan', review.unintendedChanges.join(' | ').slice(0, 300))
    }
    await events.emit('review', verification.passed ? 'success' : 'error',
      verification.passed ? 'Final review completed — verification passed' : 'Final review completed — with unresolved failures',
      `${review.diffStat.additions} additions, ${review.diffStat.deletions} deletions across ${changedFiles.length} files; ${verification.runs.length} verification run(s), ${verification.fixAttempts} fix attempt(s)`)

    // store durable memories (spec §18) — verified facts vs inferred vs assumptions
    await storeMemories(project.id, stateData, verification)

    await setState(runId, 'COMPLETED', stateData)
    await db.task.update({
      where: { id: task.id },
      data: { status: verification.passed ? 'completed' : 'failed' },
    })
    await db.agentRun.update({
      where: { id: runId },
      data: { finishedAt: new Date(), tokenUsage: providerTokenUsage(provider) },
    })
  } finally {
    liveRuns.delete(runId)
  }
}

// ------------------------------------------------------------
// helpers
// ------------------------------------------------------------

async function finishCancelled(runId: string) {
  await setState(runId, 'CANCELLED')
  const events = new RunEventLog(runId)
  await events.emit('system', 'warning', 'Run cancelled by user', 'no further actions will be taken')
  await db.agentRun.update({ where: { id: runId }, data: { finishedAt: new Date() } })
  const run = await db.agentRun.findUnique({ where: { id: runId } })
  if (run) await db.task.update({ where: { id: run.taskId }, data: { status: 'cancelled' } })
}

async function waitForDecision(runId: string, entry: { cancelled: boolean }, timeoutMs: number): Promise<'approved' | 'rejected' | 'timeout'> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (entry.cancelled) return 'rejected'
    const plan = await db.plan.findUnique({ where: { runId }, select: { status: true } })
    if (plan?.status === 'approved') return 'approved'
    if (plan?.status === 'rejected') return 'rejected'
    await new Promise((r) => setTimeout(r, 1500))
  }
  return 'timeout'
}

function extractConventions(overview: any, retrieval: RetrievalResult): string[] {
  const out: string[] = []
  for (const chunk of retrieval.chunks) {
    if (chunk.source !== 'doc' && chunk.source !== 'file') continue
    const content = chunk.content.toLowerCase()
    if (content.includes('convention')) {
      const lines = chunk.content.split('\n').filter((l) => /^[-*]\s|^\d+\.\s/.test(l.trim())).slice(0, 6)
      out.push(...lines.map((l) => l.replace(/^[-*\d.\s]+/, '').trim()).filter(Boolean))
    }
  }
  if (overview.testFrameworks?.length) out.push(`testing with ${overview.testFrameworks.join('/')}`)
  return [...new Set(out)].slice(0, 8)
}

function extractQuirks(retrieval: RetrievalResult): string[] {
  const out: string[] = []
  for (const chunk of retrieval.chunks) {
    const text = chunk.content
    if (/DO NOT|HACK|FIXME|known issue|legacy|workaround|deprecated|race condition|compatib/i.test(text)) {
      const sentences = text.split(/[.\n]/).filter((s) => /DO NOT|HACK|FIXME|known issue|legacy|workaround|deprecated|race condition|compatib/i.test(s)).slice(0, 3)
      out.push(...sentences.map((s) => s.trim()).filter((s) => s.length > 10 && s.length < 200))
    }
  }
  return [...new Set(out)].slice(0, 8)
}

function legacyRelevance(c: { subject: string; body: string }): string {
  return /HACK|workaround|DO NOT|legacy|compat/i.test(c.subject) ? 'documents a compatibility constraint' : 'historical context'
}

function providerTokenUsage(provider: LLMProvider): number {
  const usage = (provider as any).usage
  if (usage && typeof usage.promptTokens === 'number') {
    return (usage.promptTokens || 0) + (usage.completionTokens || 0)
  }
  return 0
}

function buildVerifiedList(verification: VerificationResult, commands: { kind: string; command: string; available: boolean }[]): { label: string; passed: boolean; detail: string }[] {
  const out: { label: string; passed: boolean; detail: string }[] = []
  const byKind = new Map(verification.runs.map((r) => [r.kind, r]))
  for (const c of commands) {
    const run = byKind.get(c.kind)
    if (!c.available) {
      out.push({ label: `${c.kind} (n/a)`, passed: true, detail: 'not configured in this repository' })
    } else if (run) {
      const last = [...verification.runs].reverse().find((r) => r.kind === c.kind && r.command === run.command)
      out.push({
        label: c.kind,
        passed: last?.status === 'passed',
        detail: `${last?.command || c.command} — ${last?.status || 'unknown'}${last?.classification ? ` (${last.classification})` : ''}`,
      })
    }
  }
  return out
}

function composeFinalSummary(input: {
  task: string
  plan: PlanSchema
  verification: VerificationResult
  review: FinalReview
  branch: string
  provider: string
}): string {
  const { plan, verification, review, branch } = input
  const lines: string[] = []
  lines.push(`Implemented: ${plan.objective}`)
  lines.push(`Approach: ${plan.files_to_modify.length} file(s) modified, ${plan.files_to_create.length} created, on isolated branch ${branch}.`)
  lines.push(`Verification: ${verification.runs.length} run(s) executed${verification.fixAttempts ? `, ${verification.fixAttempts} fix attempt(s)` : ''} — ${verification.finalStatus === 'all_passed' ? 'all checks passed' : verification.finalStatus === 'only_preexisting' ? 'remaining failures are pre-existing and unrelated to this change' : verification.finalStatus.replace(/_/g, ' ')}.`)
  lines.push(`Diff: ${review.diffStat.additions} additions, ${review.diffStat.deletions} deletions across ${review.changedFiles.length} files.`)
  if (review.securityFindings.length) lines.push(`Security: ${review.securityFindings.length} finding(s) — review required.`)
  if (review.unintendedChanges.length) lines.push(`Note: ${review.unintendedChanges.length} change(s) outside the planned file set.`)
  return lines.join(' ')
}

async function storeMemories(projectId: string, stateData: AgentStateObject, verification: VerificationResult) {
  try {
    const memories: { kind: string; category: string; content: string; source: string; confidence: number }[] = []
    // verified facts from index evidence
    if (stateData.repository_understanding.overview.database) {
      memories.push({ kind: 'verified_fact', category: 'architecture', content: `Persistence: ${stateData.repository_understanding.overview.database}`, source: 'repository-analysis', confidence: 0.95 })
    }
    if (stateData.repository_understanding.overview.testFrameworks?.length) {
      memories.push({ kind: 'verified_fact', category: 'convention', content: `Test framework: ${stateData.repository_understanding.overview.testFrameworks.join(', ')}`, source: 'repository-analysis', confidence: 0.95 })
    }
    // inferred from docs/comments
    for (const q of stateData.repository_understanding.quirks.slice(0, 4)) {
      memories.push({ kind: 'inferred', category: 'quirk', content: q, source: 'docs+comments', confidence: 0.7 })
    }
    // git-documented compatibility
    for (const h of stateData.historical_context.filter((h) => h.relevance.includes('compatibility')).slice(0, 3)) {
      memories.push({ kind: 'verified_fact', category: 'compatibility', content: `${h.file}: ${h.subject} (${h.commitHash}) — preserved by convention`, source: `git:${h.commitHash}`, confidence: 0.9 })
    }
    for (const m of memories) {
      await db.memory.create({ data: { projectId, ...m } })
    }
  } catch (err) {
    console.warn('[agent] memory storage failed:', err)
  }
}

void isTerminal
