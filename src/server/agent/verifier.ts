// ============================================================
// Verification engine (spec §16, §17): build/test/lint/typecheck
// inside the sandbox, classify failures (agent_caused vs
// pre_existing vs flaky vs environment), run a bounded repair
// loop, and perform the final review (diff, security scan,
// unintended changes).
// ============================================================

import fs from 'fs'
import path from 'path'
import { db } from '@/lib/db'
import type { LLMProvider } from '../llm'
import type { PlanSchema } from './planner'
import type { ToolContext } from './tools'
import { invokeTool } from './tools'
import type { RunEventLog } from './events'

export interface TestCommand {
  kind: 'test' | 'lint' | 'typecheck'
  command: string
  available: boolean
}

// ------------------------------------------------------------
// Command detection from repository config
// ------------------------------------------------------------

export function detectCommands(repoPath: string): TestCommand[] {
  const cmds: TestCommand[] = []
  const pkgFile = path.join(repoPath, 'package.json')

  const hasPy = fs.existsSync(path.join(repoPath, 'requirements.txt')) || fs.existsSync(path.join(repoPath, 'pyproject.toml'))
  const pyTests = hasPy && (fs.existsSync(path.join(repoPath, 'tests')) || fs.existsSync(path.join(repoPath, 'test')))
  const hasTsconfig = fs.existsSync(path.join(repoPath, 'tsconfig.json'))
  const hasEslint = fs.existsSync(path.join(repoPath, '.eslintrc.json')) || fs.existsSync(path.join(repoPath, '.eslintrc.js')) || fs.existsSync(path.join(repoPath, 'eslint.config.js'))

  if (fs.existsSync(pkgFile)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf8'))
      const testScript = pkg?.scripts?.test
      if (testScript && testScript !== 'echo "Error: no test specified" && exit 1') {
        cmds.push({ kind: 'test', command: testScript.includes('npm ') || testScript.includes('npx ') ? testScript : `npm test`, available: true })
      }
      if (pkg?.scripts?.lint) cmds.push({ kind: 'lint', command: 'npm run lint', available: true })
      if (pkg?.scripts?.typecheck) cmds.push({ kind: 'typecheck', command: 'npm run typecheck', available: true })
    } catch { /* ignore */ }
    if (!cmds.some((c) => c.kind === 'test')) {
      // JS repo without a test script: node --test if tests/ exists.
      // The glob form is cross-platform: POSIX shells expand it, and on
      // Windows cmd passes it through literally — where Node 21+ expands
      // globs natively in the test runner. (A bare directory arg is NOT
      // accepted; a trailing slash is treated as a file by Node 24.)
      if (fs.existsSync(path.join(repoPath, 'tests')) || fs.existsSync(path.join(repoPath, 'test'))) {
        const dir = fs.existsSync(path.join(repoPath, 'tests')) ? 'tests' : 'test'
        cmds.push({ kind: 'test', command: `node --test ${dir}/*.test.js`, available: true })
      } else {
        cmds.push({ kind: 'test', command: '', available: false })
      }
    }
  } else if (pyTests) {
    // python3 is the POSIX name; Windows installs expose `python`
    const py = process.platform === 'win32' ? 'python' : 'python3'
    cmds.push({ kind: 'test', command: `${py} -m pytest tests/ -x -q`, available: true })
  } else {
    cmds.push({ kind: 'test', command: '', available: false })
  }

  if (!cmds.some((c) => c.kind === 'lint')) {
    if (hasEslint) cmds.push({ kind: 'lint', command: 'npx eslint .', available: true })
    else cmds.push({ kind: 'lint', command: '', available: false })
  }
  if (!cmds.some((c) => c.kind === 'typecheck')) {
    if (hasTsconfig) cmds.push({ kind: 'typecheck', command: 'npx tsc --noEmit', available: true })
    else cmds.push({ kind: 'typecheck', command: '', available: false })
  }
  return cmds
}

// ------------------------------------------------------------
// Failure classification
// ------------------------------------------------------------

export type FailureClass = 'agent_caused' | 'pre_existing' | 'flaky' | 'environment' | 'unrelated'

export interface TestRunRecord {
  kind: string
  command: string
  status: 'passed' | 'failed' | 'error' | 'skipped'
  summary: string
  output: string
  durationMs: number
  fixAttempt: number
  classification: string
}

async function recordTestRun(runId: string, rec: Omit<TestRunRecord, never>) {
  await db.testRun.create({
    data: {
      runId,
      kind: rec.kind,
      command: rec.command,
      status: rec.status,
      summary: rec.summary.slice(0, 500),
      output: rec.output.slice(0, 20000),
      durationMs: rec.durationMs,
      fixAttempt: rec.fixAttempt,
      classification: rec.classification,
    },
  })
}

function summarize(output: string): string {
  // node --test / pytest style summaries
  const lines = output.split('\n').filter((l) => /^\s*(ℹ|✔|✖|# (pass|fail|tests|passed|failed|error)|FAILED|ERROR)/.test(l) || /^\s*not ok/.test(l))
  const failLines = output.split('\n').filter((l) => /✖|not ok|FAILED|AssertionError|Expected|fatal|SyntaxError|ReferenceError|TypeError/.test(l)).slice(0, 12)
  const summary = lines.slice(-12).join(' | ').slice(0, 300)
  return (summary || output.slice(0, 200)) + (failLines.length ? '\n' + failLines.join('\n') : '')
}

/**
 * Classify a failing command:
 *  - run the SAME command on the pristine canonical clone -> if it fails
 *    there too, the failure is pre-existing, not agent-caused
 *  - re-run once in the workspace -> passes => flaky
 *  - env markers (ENOENT/EACCES/timeout/network) => environment
 */
export async function classifyFailure(
  ctx: ToolContext,
  command: string,
  failedOutput: string
): Promise<{ classification: FailureClass; evidence: string }> {
  // environment markers
  if (/ECONNREFUSED|ENOTFOUND|ETIMEDOUT|EACCES|ENOENT.*node|cannot find module|exit=124|timed out|Killed/i.test(failedOutput)) {
    // missing module could be agent-caused (bad require path). check pristine clone
    const pristine = await invokeTool({ ...ctx, workspacePath: ctx.repoPath }, 'run_command', { command })
    if (!pristine.ok && /ECONNREFUSED|EACCES|ENOENT/.test(pristine.output)) {
      return { classification: 'environment', evidence: `same failure on the pristine clone: ${summarize(pristine.output).slice(0, 150)}` }
    }
  }
  // pristine comparison
  const pristine = await invokeTool({ ...ctx, workspacePath: ctx.repoPath }, 'run_command', { command })
  if (!pristine.ok) {
    return { classification: 'pre_existing', evidence: `the same command fails on the UNMODIFIED repository: ${summarize(pristine.output).slice(0, 200)}` }
  }
  // flake check: re-run once in workspace
  const rerun = await invokeTool(ctx, 'run_command', { command })
  if (rerun.ok) {
    return { classification: 'flaky', evidence: 'failed once, passed on immediate re-run under identical conditions' }
  }
  return { classification: 'agent_caused', evidence: `passes on the pristine clone, fails consistently in the workspace — caused by this run's changes. ${summarize(failedOutput).slice(0, 150)}` }
}

// ------------------------------------------------------------
// Repair loop
// ------------------------------------------------------------

export interface VerificationResult {
  passed: boolean
  runs: TestRunRecord[]
  fixAttempts: number
  finalStatus: 'all_passed' | 'agent_failures_unresolved' | 'only_preexisting' | 'nothing_to_run'
}

export async function verifyAndRepair(
  provider: LLMProvider,
  ctx: ToolContext,
  plan: PlanSchema,
  events: RunEventLog,
  opts: { maxFixAttempts?: number } = {}
): Promise<VerificationResult> {
  const maxFix = opts.maxFixAttempts ?? 2
  const commands = detectCommands(ctx.repoPath)
  const runs: TestRunRecord[] = []
  let fixAttempts = 0

  await events.emit('verification', 'status', 'Detecting verification commands', commands.map((c) => `${c.kind}: ${c.command || 'n/a'}`).join(' | '))

  const testCmd = commands.find((c) => c.kind === 'test' && c.available)
  if (!testCmd) {
    await events.warn('verification', 'No test command detected', 'verification will rely on lint/typecheck and diff review only')
  }

  // initial run of everything available
  for (const cmd of commands.filter((c) => c.available)) {
    const tool = cmd.kind === 'test' ? 'run_tests' : cmd.kind === 'lint' ? 'run_lint' : 'run_typecheck'
    const res = await invokeTool(ctx, tool, { command: cmd.command })
    const status: TestRunRecord['status'] = res.ok ? 'passed' : 'failed'
    const rec: TestRunRecord = {
      kind: cmd.kind,
      command: cmd.command,
      status,
      summary: res.ok ? 'passed' : summarize(res.output),
      output: res.output,
      durationMs: Number(res.data?.durationMs || 0),
      fixAttempt: 0,
      classification: res.ok ? '' : '',
    }
    if (!res.ok && cmd.kind === 'test') {
      const cls = await classifyFailure(ctx, cmd.command, res.output)
      rec.classification = cls.classification
      await events.emit('verification', cls.classification === 'pre_existing' ? 'warning' : 'error',
        `Tests FAILED (${cls.classification})`, cls.evidence.slice(0, 400), { data: { classification: cls.classification } })
    } else {
      await events.emit('verification', res.ok ? 'success' : 'error', `${cap(cmd.kind)} ${res.ok ? 'passed' : 'failed'}`, res.ok ? `${cmd.command} (${rec.durationMs}ms)` : rec.summary.slice(0, 300))
    }
    await recordTestRun(ctx.runId, rec)
    runs.push(rec)
  }

  // repair loop only for agent-caused test failures
  while (fixAttempts < maxFix) {
    const failing = runs.filter((r) => r.status === 'failed' && (r.classification === 'agent_caused' || r.classification === ''))
    if (failing.length === 0) break
    const target = failing[0]
    fixAttempts++
    await events.emit('fix', 'status', `Fix attempt ${fixAttempts}: diagnosing failure`, target.summary.slice(0, 300))

    const fixed = await attemptRepair(provider, ctx, plan, target, events)
    if (!fixed) {
      await events.warn('fix', `Fix attempt ${fixAttempts} did not produce a patch`, 'repair strategy exhausted for this failure')
      continue
    }
    // re-run the failed command
    const res = await invokeTool(ctx, 'run_tests', { command: target.command })
    const rec: TestRunRecord = {
      kind: target.kind,
      command: target.command,
      status: res.ok ? 'passed' : 'failed',
      summary: res.ok ? 'passed after fix' : summarize(res.output),
      output: res.output,
      durationMs: Number(res.data?.durationMs || 0),
      fixAttempt: fixAttempts,
      classification: res.ok ? '' : await (async () => {
        const cls = await classifyFailure(ctx, target.command, res.output)
        return cls.classification
      })(),
    }
    await recordTestRun(ctx.runId, rec)
    runs.push(rec)
    await events.emit(res.ok ? 'fix' : 'fix', res.ok ? 'success' : 'error',
      res.ok ? `Fix attempt ${fixAttempts} succeeded — tests now pass` : `Fix attempt ${fixAttempts} — still failing`,
      res.ok ? `${target.command}` : rec.summary.slice(0, 300))
  }

  // final full-suite run if any fix was applied
  if (fixAttempts > 0 && testCmd) {
    const res = await invokeTool(ctx, 'run_tests', { command: testCmd.command })
    const rec: TestRunRecord = {
      kind: 'test',
      command: testCmd.command,
      status: res.ok ? 'passed' : 'failed',
      summary: res.ok ? 'full suite passed after fixes' : summarize(res.output),
      output: res.output,
      durationMs: Number(res.data?.durationMs || 0),
      fixAttempt: fixAttempts,
      classification: res.ok ? '' : 'agent_caused',
    }
    await recordTestRun(ctx.runId, rec)
    runs.push(rec)
  }

  const testRuns = runs.filter((r) => r.kind === 'test')
  const finalStatus: VerificationResult['finalStatus'] = testRuns.length === 0
    ? (runs.some((r) => r.status === 'passed') ? 'all_passed' : 'nothing_to_run')
    : testRuns.every((r) => r.status === 'passed') ? 'all_passed'
    : testRuns.every((r) => r.status !== 'passed' && (r.classification === 'pre_existing' || r.classification === 'environment')) ? 'only_preexisting'
    : 'agent_failures_unresolved'

  return { passed: finalStatus === 'all_passed' || finalStatus === 'only_preexisting', runs, fixAttempts, finalStatus }
}

// ------------------------------------------------------------
// Repair attempt (LLM patch or common heuristic fixes)
// ------------------------------------------------------------

async function attemptRepair(provider: LLMProvider, ctx: ToolContext, plan: PlanSchema, failure: TestRunRecord, events: RunEventLog): Promise<boolean> {
  if (provider.capabilities.freeformChat) {
    try {
      // collect the workspace diff + failing test output for diagnosis
      const diff = await invokeTool(ctx, 'git_diff', {})
      const changedFiles = [...plan.files_to_modify, ...plan.files_to_create]
      const contents = changedFiles.map((rel) => {
        try {
          const abs = path.join(ctx.workspacePath, rel)
          if (!abs.startsWith(path.resolve(ctx.workspacePath))) return ''
          return `=== ${rel} ===\n${fs.readFileSync(abs, 'utf8').slice(0, 10000)}`
        } catch { return '' }
      }).filter(Boolean).join('\n\n')

      const system = `You are the failure-repair engine of a brownfield engineering agent. A test failed after your changes. Diagnose the root cause and produce a MINIMAL unified diff fix. Respond ONLY with a unified diff (no prose, no fences).`
      const user = `TASK: ${plan.objective}

FAILING COMMAND: ${failure.command}
FAILURE OUTPUT:
${failure.output.slice(0, 6000)}

CURRENT DIFF:
${diff.output.slice(0, 6000)}

RELEVANT FILE CONTENTS:
${contents.slice(0, 20000)}

Produce the minimal fix as a unified diff.`

      const result = await provider.chat({ role: 'coding', system, messages: [{ role: 'user', content: user }], temperature: 0.1, maxTokens: 3000 })
      const patchResult = await invokeTool(ctx, 'apply_patch', { patch: result.content })
      if (patchResult.ok) {
        await events.emit('fix', 'success', 'Repair patch applied', patchResult.output.slice(0, 200))
        return true
      }
      await events.warn('fix', 'Repair patch rejected', patchResult.output.slice(0, 200))
      return false
    } catch (err: any) {
      await events.warn('fix', 'LLM repair error', String(err?.message).slice(0, 200))
      return false
    }
  }
  return false
}

// ------------------------------------------------------------
// Final review (spec §17)
// ------------------------------------------------------------

export interface FinalReview {
  changedFiles: { file: string; changeType: string; additions: number; deletions: number; diff: string }[]
  securityFindings: string[]
  unintendedChanges: string[]
  diffStat: { additions: number; deletions: number }
}

const SECRET_PATTERNS: { re: RegExp; label: string }[] = [
  { re: /AKIA[0-9A-Z]{16}/, label: 'AWS access key' },
  { re: /-----BEGIN (RSA |EC )?PRIVATE KEY-----/, label: 'private key material' },
  { re: /(?:api[_-]?key|secret|password|token)\s*[:=]\s*['"][A-Za-z0-9+/_-]{16,}['"]/i, label: 'hardcoded credential' },
  { re: /ghp_[A-Za-z0-9]{30,}/, label: 'GitHub token' },
  { re: /sk-[A-Za-z0-9]{20,}/, label: 'API secret key' },
]

export function finalReview(changedFiles: { path: string; changeType: string; additions: number; deletions: number; diff: string }[], plan: PlanSchema): FinalReview {
  const securityFindings: string[] = []
  const unintendedChanges: string[] = []
  let additions = 0
  let deletions = 0

  const planned = new Set([...plan.files_to_modify, ...plan.files_to_create, ...plan.files_to_delete])

  for (const f of changedFiles) {
    additions += f.additions
    deletions += f.deletions
    if (!planned.has(f.path)) {
      unintendedChanges.push(`${f.path} changed but not in the approved plan`)
    }
    for (const line of f.diff.split('\n')) {
      if (!line.startsWith('+') || line.startsWith('+++')) continue
      for (const { re, label } of SECRET_PATTERNS) {
        if (re.test(line)) securityFindings.push(`${f.path}: possible ${label} in added line`)
      }
    }
  }

  return { changedFiles, securityFindings, unintendedChanges, diffStat: { additions, deletions } }
}

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1)
}
