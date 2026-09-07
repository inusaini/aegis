// ============================================================
// Tool gateway (spec §11): the ONLY surface through which the
// agent touches the repository. Repository tools, git tools,
// modification tools, execution tools — each validated,
// sandboxed, and logged.
// ============================================================

import fs from 'fs'
import path from 'path'
import { RepoGraph } from '../intelligence/graph'
import { db } from '@/lib/db'
import { execInSandbox, screenCommand } from '../sandbox/executor'
import * as git from '../intelligence/git'
import { RunEventLog } from './events'

export type ToolResult = { ok: boolean; output: string; data?: Record<string, unknown> }

export interface ToolContext {
  runId: string
  repositoryId: string
  repoPath: string // canonical clone (read-only investigation)
  workspacePath: string // isolated worktree (modifications)
  graph: RepoGraph
  events: RunEventLog
}

export type ToolName =
  // repository tools
  | 'search_code' | 'open_file' | 'list_directory' | 'find_symbol' | 'find_references'
  | 'get_dependencies' | 'get_callers' | 'get_callees' | 'get_tests'
  // git tools
  | 'git_status' | 'git_log' | 'git_blame' | 'git_diff'
  // modification tools
  | 'create_file' | 'write_file' | 'edit_file' | 'apply_patch'
  // execution tools
  | 'run_command' | 'run_tests' | 'run_lint' | 'run_typecheck'

export const TOOL_CATALOG: { name: ToolName; group: string; description: string }[] = [
  { name: 'search_code', group: 'repository', description: 'Search file paths and symbol names by keyword' },
  { name: 'open_file', group: 'repository', description: 'Read a file (workspace, or canonical clone for untouched files)' },
  { name: 'list_directory', group: 'repository', description: 'List files under a directory prefix' },
  { name: 'find_symbol', group: 'repository', description: 'Look up symbols by name' },
  { name: 'find_references', group: 'repository', description: 'Find references to a symbol' },
  { name: 'get_dependencies', group: 'repository', description: 'Local and external dependencies of a file' },
  { name: 'get_callers', group: 'repository', description: 'Callers of a symbol' },
  { name: 'get_callees', group: 'repository', description: 'Callees of a symbol' },
  { name: 'get_tests', group: 'repository', description: 'Test files covering a file' },
  { name: 'git_status', group: 'git', description: 'Working tree status of the run workspace' },
  { name: 'git_log', group: 'git', description: 'Commit history (canonical clone)' },
  { name: 'git_blame', group: 'git', description: 'Blame a file to find where lines came from' },
  { name: 'git_diff', group: 'git', description: 'Diff of the workspace vs base' },
  { name: 'create_file', group: 'modification', description: 'Create a new file in the workspace' },
  { name: 'write_file', group: 'modification', description: 'Overwrite a workspace file with complete new content' },
  { name: 'edit_file', group: 'modification', description: 'Apply anchored text edits to a workspace file' },
  { name: 'apply_patch', group: 'modification', description: 'Apply a unified diff patch to the workspace' },
  { name: 'run_command', group: 'execution', description: 'Run an allowlisted command in the sandbox' },
  { name: 'run_tests', group: 'execution', description: 'Run the repository test suite' },
  { name: 'run_lint', group: 'execution', description: 'Run the repository linter if configured' },
  { name: 'run_typecheck', group: 'execution', description: 'Run type checking if configured' },
]

// ------------------------------------------------------------
// Validation helpers
// ------------------------------------------------------------

const MAX_FILE_READ = 400_000

/** A path is safe if it resolves inside the given root and has no traversal. */
function safeJoin(root: string, rel: string): string | null {
  if (!rel || rel.includes('\0')) return null
  const abs = path.resolve(root, rel)
  if (!abs.startsWith(path.resolve(root))) return null
  return abs
}

function readText(abs: string): string | null {
  try {
    const st = fs.statSync(abs)
    if (st.size > MAX_FILE_READ) return fs.readFileSync(abs, 'utf8').slice(0, MAX_FILE_READ)
    return fs.readFileSync(abs, 'utf8')
  } catch {
    return null
  }
}

// ------------------------------------------------------------
// Tool implementations
// ------------------------------------------------------------

export async function invokeTool(ctx: ToolContext, tool: ToolName, args: Record<string, any>): Promise<ToolResult> {
  const e = ctx.events
  switch (tool) {
    // ---------------- repository tools ----------------
    case 'search_code': {
      const query = String(args.query || '').slice(0, 200)
      if (!query) return { ok: false, output: 'query required' }
      const hits = ctx.graph.findSymbol(query).slice(0, 20)
      const fileHits = [...ctx.graph.files.keys()].filter((p) => p.toLowerCase().includes(query.toLowerCase())).slice(0, 20)
      const out = [
        ...hits.map((s) => `${s.kind} ${s.qualifiedName} L${s.lineStart}`),
        ...fileHits.map((p) => `file ${p}`),
      ].join('\n') || 'no matches'
      await e.tool('investigation', 'search_code', { query }, `${hits.length} symbols, ${fileHits.length} files`)
      return { ok: true, output: out, data: { symbols: hits.length, files: fileHits.length } }
    }

    case 'open_file': {
      const rel = String(args.path || '')
      // prefer the workspace copy (may contain the agent's edits)
      const wsFile = safeJoin(ctx.workspacePath, rel)
      const canonical = safeJoin(ctx.repoPath, rel)
      const abs = wsFile && fs.existsSync(wsFile) ? wsFile : canonical
      if (!abs) return { ok: false, output: `invalid path: ${rel}` }
      const content = readText(abs)
      if (content == null) return { ok: false, output: `cannot read ${rel}` }
      await e.tool('investigation', 'open_file', { path: rel }, `${content.split('\n').length} lines`)
      return { ok: true, output: content, data: { path: rel, lines: content.split('\n').length } }
    }

    case 'list_directory': {
      const prefix = String(args.path || '').replace(/^\/+/, '')
      const entries = [...ctx.graph.files.keys()]
        .filter((p) => p.startsWith(prefix))
        .map((p) => (prefix ? p.slice(prefix.length + 1).split('/')[0] : p.split('/')[0]))
        .filter(Boolean)
      const unique = [...new Set(entries)].slice(0, 100)
      await e.tool('investigation', 'list_directory', { path: prefix }, `${unique.length} entries`)
      return { ok: true, output: unique.join('\n'), data: { count: unique.length } }
    }

    case 'find_symbol': {
      const name = String(args.name || '')
      if (!name) return { ok: false, output: 'name required' }
      const syms = ctx.graph.findSymbol(name).slice(0, 20)
      await e.tool('investigation', 'find_symbol', { name }, `${syms.length} matches`)
      return {
        ok: true,
        output: syms.map((s) => `${s.kind} ${s.qualifiedName} L${s.lineStart}-${s.lineEnd}\n  ${s.signature}\n  ${s.docComment ? s.docComment.split('\n')[0] : ''}`).join('\n'),
        data: { count: syms.length },
      }
    }

    case 'find_references': {
      const qn = String(args.symbol || '')
      const refs = ctx.graph.findReferences(qn)
      await e.tool('investigation', 'find_references', { symbol: qn }, `${refs.length} references`)
      return { ok: true, output: refs.map((r) => `${r.kind}: ${r.file}${r.fromSymbol ? ' (' + r.fromSymbol + ')' : ''}`).join('\n') || 'no references' }
    }

    case 'get_dependencies': {
      const file = String(args.file || '')
      const deps = ctx.graph.getDependencies(file)
      await e.tool('investigation', 'get_dependencies', { file }, `${deps.local.length} local, ${deps.external.length} external`)
      return { ok: true, output: JSON.stringify(deps, null, 2), data: deps }
    }

    case 'get_callers': {
      const qn = String(args.symbol || '')
      const callers = ctx.graph.getCallers(qn)
      await e.tool('investigation', 'get_callers', { symbol: qn }, `${callers.length} callers`)
      return { ok: true, output: callers.map((c) => `${c.file}${c.fromSymbol ? ' :: ' + c.fromSymbol : ''}`).join('\n') || 'no callers' }
    }

    case 'get_callees': {
      const qn = String(args.symbol || '')
      const callees = ctx.graph.getCallees(qn)
      await e.tool('investigation', 'get_callees', { symbol: qn }, `${callees.length} callees`)
      return { ok: true, output: callees.join('\n') || 'no callees' }
    }

    case 'get_tests': {
      const file = String(args.file || '')
      const tests = ctx.graph.getRelatedTests(file)
      await e.tool('investigation', 'get_tests', { file }, `${tests.length} test files`)
      return { ok: true, output: tests.join('\n') || 'no tests found', data: { tests } }
    }

    // ---------------- git tools ----------------
    case 'git_status': {
      const res = await execInSandbox('git status --porcelain', { cwd: ctx.workspacePath, timeoutMs: 15_000 })
      await e.tool('investigation', 'git_status', {}, res.stdout.trim().split('\n').filter(Boolean).length + ' changed files')
      return { ok: res.exitCode === 0, output: res.stdout || '(clean)' }
    }

    case 'git_log': {
      const file = args.file ? String(args.file) : undefined
      const limit = Math.min(Number(args.limit) || 10, 30)
      const commits = git.getLog(ctx.repoPath, { file, limit })
      await e.tool('investigation', 'git_log', { file: file || '(all)', limit }, `${commits.length} commits`)
      return {
        ok: true,
        output: commits.map((c) => `${c.shortHash} ${c.date?.slice(0, 10)} ${c.subject}${c.files.length ? ` [${c.files.slice(0, 4).join(', ')}]` : ''}`).join('\n'),
        data: { count: commits.length },
      }
    }

    case 'git_blame': {
      const file = String(args.file || '')
      const start = Number(args.start) || undefined
      const end = Number(args.end) || undefined
      if (!file) return { ok: false, output: 'file required' }
      const blame = git.blameFile(ctx.repoPath, file, start, end)
      if (!blame) return { ok: false, output: `cannot blame ${file}` }
      await e.tool('investigation', 'git_blame', { file, start, end }, `${blame.commits.length} contributing commits`)
      return {
        ok: true,
        output: blame.commits.map((c) => `${c.hash.slice(0, 8)} ${c.author} ${c.date?.slice(0, 10)} (${c.lineCount} lines): ${c.subject}`).join('\n'),
        data: { commits: blame.commits.slice(0, 5) },
      }
    }

    case 'git_diff': {
      const res = await execInSandbox('git diff HEAD', { cwd: ctx.workspacePath, timeoutMs: 30_000 })
      await e.tool('implementation', 'git_diff', {}, `${res.stdout.split('\n').filter((l) => l.startsWith('+') && !l.startsWith('+++')).length} added lines`)
      return { ok: res.exitCode === 0, output: res.stdout || '(no changes)' }
    }

    // ---------------- modification tools ----------------
    case 'create_file': {
      const rel = String(args.path || '')
      const content = String(args.content || '')
      const abs = safeJoin(ctx.workspacePath, rel)
      if (!abs) return { ok: false, output: `invalid path: ${rel}` }
      if (fs.existsSync(abs)) return { ok: false, output: `file already exists: ${rel}` }
      fs.mkdirSync(path.dirname(abs), { recursive: true })
      fs.writeFileSync(abs, content)
      await e.tool('implementation', 'create_file', { path: rel }, `${content.split('\n').length} lines written`)
      return { ok: true, output: `created ${rel} (${content.length} bytes)` }
    }

    case 'write_file': {
      const rel = String(args.path || '')
      const content = String(args.content || '')
      const abs = safeJoin(ctx.workspacePath, rel)
      if (!abs) return { ok: false, output: `invalid path: ${rel}` }
      if (!fs.existsSync(abs)) return { ok: false, output: `file does not exist (use create_file): ${rel}` }
      fs.writeFileSync(abs, content)
      await e.tool('implementation', 'write_file', { path: rel }, `${content.split('\n').length} lines written`) 
      return { ok: true, output: `wrote ${rel} (${content.length} bytes)` }
    }

    case 'edit_file': {
      const rel = String(args.path || '')
      const edits = Array.isArray(args.edits) ? args.edits : []
      // each edit: { find: string, replace: string, expect?: number }
      const abs = safeJoin(ctx.workspacePath, rel)
      if (!abs) return { ok: false, output: `invalid path: ${rel}` }
      let content = readText(abs)
      if (content == null) return { ok: false, output: `cannot read ${rel}` }
      let applied = 0
      const problems: string[] = []
      for (const edit of edits) {
        const find = String(edit.find || '')
        const replace = String(edit.replace ?? '')
        if (!find) { problems.push('empty find'); continue }
        const count = content.split(find).length - 1
        if (count === 0) { problems.push(`anchor not found: ${find.slice(0, 60)}`); continue }
        if (count > 1 && !edit.replaceAll) { problems.push(`anchor ambiguous (${count} matches): ${find.slice(0, 60)}`); continue }
        content = edit.replaceAll ? content.split(find).join(replace) : content.replace(find, replace)
        applied++
      }
      if (applied > 0) fs.writeFileSync(abs, content)
      const editOk = applied > 0 && problems.length === 0
      await e.tool('implementation', 'edit_file', { path: rel, applied, problems }, `${applied}/${edits.length} edits applied${problems.length ? ' — ' + problems.join('; ').slice(0, 200) : ''}`, editOk)
      return {
        ok: editOk,
        output: `applied ${applied}/${edits.length} edits${problems.length ? '; problems: ' + problems.join('; ') : ''}`,
        data: { applied, problems },
      }
    }

    case 'apply_patch': {
      const patch = String(args.patch || '')
      if (!patch) return { ok: false, output: 'patch required' }
      const { applyUnifiedPatch } = await import('./patcher')
      const result = await applyUnifiedPatch(ctx.workspacePath, patch)
      await e.tool('implementation', 'apply_patch', { files: result.files }, result.ok ? `${result.files.length} file(s) patched` : `patch failed: ${result.error}`)
      return result
    }

    // ---------------- execution tools ----------------
    case 'run_command': {
      const command = String(args.command || '')
      const res = await execInSandbox(command, { cwd: ctx.workspacePath, timeoutMs: Number(args.timeoutMs) || 120_000 })
      const ok = res.exitCode === 0 && !res.blocked
      await e.tool('verification', 'run_command', { command }, res.blocked ? `BLOCKED: ${res.blocked}` : `exit=${res.exitCode} in ${res.durationMs}ms`)
      return { ok, output: (res.blocked ? `BLOCKED: ${res.blocked}\n` : '') + (res.stdout || res.stderr).slice(0, 8000), data: { exitCode: res.exitCode, timedOut: res.timedOut } }
    }

    case 'run_tests':
    case 'run_lint':
    case 'run_typecheck': {
      const command = String(args.command || '')
      const kind = tool === 'run_tests' ? 'test' : tool === 'run_lint' ? 'lint' : 'typecheck'
      const res = await execInSandbox(command, { cwd: ctx.workspacePath, timeoutMs: 240_000 })
      const ok = res.exitCode === 0 && !res.blocked
      await e.tool('verification', tool, { command }, res.blocked ? `BLOCKED: ${res.blocked}` : `exit=${res.exitCode} (${res.durationMs}ms)`)
      return { ok, output: (res.blocked ? `BLOCKED: ${res.blocked}\n` : '') + (res.stdout || res.stderr).slice(0, 12000), data: { exitCode: res.exitCode, durationMs: res.durationMs, timedOut: res.timedOut, kind } }
    }

    default:
      return { ok: false, output: `unknown tool: ${tool}` }
  }
}

/** Expose the catalog for the UI / docs. */
export function toolCatalog() {
  return TOOL_CATALOG
}

// keep db import used (graph loads via RepoGraph elsewhere)
void db
