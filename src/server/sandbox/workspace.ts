// ============================================================
// Workspace manager (spec §12): every agent run gets an
// EPHEMERAL git worktree of the repository clone:
//
//   canonical clone (.agent-data/repos/<repoId>)
//        ↓ git worktree add
//   run workspace (.agent-data/workspaces/<runId>/repo)
//
// Worktrees give real isolation: the run's branch cannot touch
// the canonical checkout, and cleanup is `git worktree remove`.
// ============================================================

import fs from 'fs'
import path from 'path'
import { shSync } from './shell'

const DATA_DIR = path.join(process.cwd(), '.agent-data')
export const REPOS_DIR = path.join(DATA_DIR, 'repos')
export const WORKSPACES_DIR = path.join(DATA_DIR, 'workspaces')

function sh(cmd: string, cwd: string, timeout = 60_000): string {
  // Cross-platform: explicit cmd.exe on Windows / /bin/sh on POSIX
  // (Bun's execSync default shell is /bin/sh, which breaks Windows).
  return shSync(cmd, { cwd, timeout })
}

export function repoPathFor(repositoryId: string): string {
  return path.join(REPOS_DIR, repositoryId)
}

export function workspacePathFor(runId: string): string {
  return path.join(WORKSPACES_DIR, runId, 'repo')
}

/** slugify a task title into a branch name */
export function branchNameFor(taskTitle: string): string {
  const slug = taskTitle
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
  return `agent/${slug || 'task'}`
}

/**
 * Materialize the canonical repository copy:
 *  - sample: copy from sample-repos/legacy-shop (git history preserved)
 *  - local path: copy (git history preserved)
 *  - remote: git clone
 */
export async function materializeRepository(
  repositoryId: string,
  source: string,
  sourceType: string
): Promise<{ path: string; branch: string }> {
  const dest = repoPathFor(repositoryId)
  fs.mkdirSync(REPOS_DIR, { recursive: true })

  if (sourceType === 'sample' || sourceType === 'local') {
    const src = sourceType === 'sample' ? path.join(process.cwd(), 'sample-repos', 'legacy-shop') : source
    if (!fs.existsSync(src)) throw new Error(`source repository path does not exist: ${src}`)
    // fresh copy including .git
    if (fs.existsSync(dest)) fs.rmSync(dest, { recursive: true, force: true })
    fs.cpSync(src, dest, { recursive: true, filter: (f) => !f.includes('node_modules') })
  } else {
    if (fs.existsSync(dest)) fs.rmSync(dest, { recursive: true, force: true })
    sh(`git clone --depth 50 ${JSON.stringify(source)} ${JSON.stringify(dest)}`, DATA_DIR, 120_000)
  }

  // ensure a git identity for agent commits (scoped to this clone only)
  try {
    sh('git config user.name "AEGIS Agent"', dest)
    sh('git config user.email "agent@aegis.local"', dest)
    sh('git config commit.gpgsign false', dest)
  } catch { /* non-fatal */ }

  let branch = 'main'
  try {
    branch = sh('git rev-parse --abbrev-ref HEAD', dest).trim()
  } catch { /* keep default */ }

  return { path: dest, branch }
}

export interface Workspace {
  runId: string
  path: string
  branch: string
}

/** Create an isolated git worktree + branch for an agent run. */
export function createWorkspace(runId: string, repoPath: string, branch: string): Workspace {
  const wsPath = workspacePathFor(runId)
  fs.mkdirSync(path.dirname(wsPath), { recursive: true })

  // worktree add with a new branch based on current HEAD
  sh(`git worktree add -b ${JSON.stringify(branch)} ${JSON.stringify(wsPath)}`, repoPath)

  // agent identity inside the worktree
  try {
    sh('git config user.name "AEGIS Agent"', wsPath)
    sh('git config user.email "agent@aegis.local"', wsPath)
  } catch { /* non-fatal */ }

  return { runId, path: wsPath, branch }
}

/** Remove the ephemeral worktree (files + git metadata). */
export function removeWorkspace(runId: string, repoPath: string): void {
  const wsPath = workspacePathFor(runId)
  try {
    sh(`git worktree remove --force ${JSON.stringify(wsPath)}`, repoPath)
  } catch {
    // worktree metadata may be gone already; force-remove leftovers
    if (fs.existsSync(wsPath)) fs.rmSync(path.dirname(wsPath), { recursive: true, force: true })
  }
  // prune stale branch refs on next use; keep branch for inspection
}

/** Read the final diff of a workspace vs its base commit. */
export function workspaceDiff(wsPath: string): string {
  // No shell chaining (`&&`, `||`) or `2>/dev/null` here — those are
  // sh-isms; this must run under cmd.exe on Windows too.
  try { sh('git add -A', wsPath) } catch { /* ignore */ }
  try {
    return sh('git diff --cached HEAD', wsPath, 120_000)
  } catch {
    try {
      return sh('git diff HEAD', wsPath, 120_000)
    } catch {
      return ''
    }
  }
}

/** Changed files in a workspace (unstaged+staged vs HEAD). */
export function workspaceChangedFiles(wsPath: string): { path: string; changeType: 'modified' | 'created' | 'deleted'; additions: number; deletions: number; diff: string }[] {
  const files: { path: string; changeType: 'modified' | 'created' | 'deleted'; additions: number; deletions: number; diff: string }[] = []
  try {
    sh('git add -A', wsPath)
    const porcelain = sh('git status --porcelain', wsPath)
    for (const line of porcelain.split('\n').filter(Boolean)) {
      const status = line.slice(0, 2).trim()
      const file = line.slice(3).trim().replace(/^"|"$/g, '')
      const changeType = status.includes('D') ? 'deleted' : status === 'A' || status === '??' ? 'created' : 'modified'
      let diff = ''
      let additions = 0
      let deletions = 0
      try {
        diff = sh(`git diff --cached HEAD -- ${JSON.stringify(file)}`, wsPath, 60_000)
        for (const dl of diff.split('\n')) {
          if (dl.startsWith('+') && !dl.startsWith('+++')) additions++
          if (dl.startsWith('-') && !dl.startsWith('---')) deletions++
        }
      } catch { /* ignore */ }
      files.push({ path: file, changeType, additions, deletions, diff })
    }
  } catch { /* ignore */ }
  return files
}

/** Commit workspace changes on the run branch. */
export function commitWorkspace(wsPath: string, message: string): { committed: boolean; hash: string } {
  try {
    sh('git add -A', wsPath)
    const status = sh('git status --porcelain', wsPath).trim()
    if (!status) return { committed: false, hash: '' }
    sh(`git commit -m ${JSON.stringify(message)}`, wsPath)
    const hash = sh('git rev-parse --short HEAD', wsPath).trim()
    return { committed: true, hash }
  } catch (err: any) {
    throw new Error(`commit failed: ${err?.message}`)
  }
}
