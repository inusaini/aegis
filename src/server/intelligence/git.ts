// ============================================================
// Git utilities — log, blame, diff, show. Git history is a
// first-class source of brownfield knowledge (spec §7).
// All commands run with a strict timeout and are read-only.
// ============================================================

import fs from 'fs'
import path from 'path'
import { shSync } from '../sandbox/shell'

const GIT_TIMEOUT = 30_000

export interface CommitInfo {
  hash: string
  shortHash: string
  author: string
  date: string
  subject: string
  body: string
  files: string[]
}

function git(repoPath: string, args: string, timeout = GIT_TIMEOUT): string {
  // Cross-platform shell (cmd.exe on Windows / /bin/sh on POSIX)
  return shSync(`git ${args}`, {
    cwd: repoPath,
    timeout,
    maxBuffer: 32 * 1024 * 1024,
  })
}

export function isGitRepo(dir: string): boolean {
  try {
    return fs.existsSync(path.join(dir, '.git')) || !!git(dir, 'rev-parse --git-dir').trim()
  } catch {
    return false
  }
}

export function getDefaultBranch(repoPath: string): string {
  try {
    const symbolic = git(repoPath, 'symbolic-ref refs/remotes/origin/HEAD').trim()
    if (symbolic) return symbolic.replace('refs/remotes/origin/', '')
  } catch { /* no remote */ }
  try {
    const head = git(repoPath, 'symbolic-ref HEAD').trim() // refs/heads/main
    return head.replace('refs/heads/', '')
  } catch { /* detached */ }
  return 'main'
}

export function getHeadCommit(repoPath: string): string {
  try {
    return git(repoPath, 'rev-parse HEAD').trim()
  } catch {
    return ''
  }
}

export function listBranches(repoPath: string): string[] {
  try {
    // Double quotes: portable across /bin/sh AND cmd.exe (single quotes are
    // literal characters to cmd and would corrupt the format string)
    return git(repoPath, `branch --format=${JSON.stringify('%(refname:short)')}`)
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean)
  } catch {
    return []
  }
}

export function getLog(repoPath: string, opts: { file?: string; limit?: number; search?: string } = {}): CommitInfo[] {
  const limit = opts.limit ?? 50
  const format = '%x1e%H%x1f%h%x1f%an%x1f%aI%x1f%s%x1f%b'
  // JSON.stringify → double quotes: portable across /bin/sh AND cmd.exe
  let args = `log -n ${limit} --name-only --pretty=format:${JSON.stringify(format)}`
  if (opts.file) args += ` -- ${JSON.stringify(opts.file)}`
  if (opts.search) args += ` --grep=${JSON.stringify(opts.search)} -i`
  try {
    const out = git(repoPath, args)
    return out
      .split('\x1e')
      .map((chunk) => chunk.trim())
      .filter(Boolean)
      .map((chunk) => {
        const parts = chunk.split('\x1f')
        const hash = parts[0] || ''
        const shortHash = parts[1] || ''
        const author = parts[2] || ''
        const date = parts[3] || ''
        const subject = parts[4] || ''
        const rest = parts.slice(5).join('\x1f')
        // body, then a blank line, then the --name-only file list
        const splitIdx = rest.indexOf('\n\n')
        const body = (splitIdx >= 0 ? rest.slice(0, splitIdx) : rest).trim()
        const filesStr = splitIdx >= 0 ? rest.slice(splitIdx + 2) : ''
        const files = filesStr
          .split('\n')
          .map((l) => l.trim())
          .filter((l) => l && !l.includes('\x1f'))
        return { hash, shortHash, author, date, subject, body, files }
      })
      .filter((c) => c.hash)
  } catch {
    return []
  }
}

export interface BlameLine {
  line: number
  hash: string
  author: string
  date: string
  code: string
}

export interface BlameSummary {
  lines: BlameLine[]
  commits: { hash: string; author: string; date: string; lineCount: number; subject: string }[]
}

export function blameFile(repoPath: string, relFile: string, startLine?: number, endLine?: number): BlameSummary | null {
  try {
    let range = ''
    if (startLine && endLine) range = `-L ${startLine},${endLine}`
    const out = git(repoPath, `blame --porcelain ${range} -- ${JSON.stringify(relFile)}`)
    const lines: BlameLine[] = []
    const commitMeta = new Map<string, { author: string; date: string }>()
    let currentHash = ''
    for (const raw of out.split('\n')) {
      const m = raw.match(/^([0-9a-f]{40}) (\d+) (\d+)/)
      if (m) {
        currentHash = m[1]
        lines.push({ hash: currentHash, line: parseInt(m[2], 10), author: '', date: '', code: '' })
        continue
      }
      if (!currentHash) continue
      const authorM = raw.match(/^author (.*)$/)
      if (authorM && !commitMeta.has(currentHash)) commitMeta.set(currentHash, { author: authorM[1], date: '' })
      const dateM = raw.match(/^author-time (.*)$/)
      if (dateM) {
        const meta = commitMeta.get(currentHash)
        if (meta && !meta.date) meta.date = new Date(parseInt(dateM[1], 10) * 1000).toISOString()
      }
      const codeM = raw.match(/^\t(.*)$/)
      if (codeM) {
        const last = lines[lines.length - 1]
        if (last) last.code = codeM[1]
      }
    }
    for (const l of lines) {
      const meta = commitMeta.get(l.hash)
      l.author = meta?.author || 'unknown'
      l.date = meta?.date || ''
    }
    const byCommit = new Map<string, { hash: string; author: string; date: string; lineCount: number; subject: string }>()
    for (const l of lines) {
      const entry = byCommit.get(l.hash) || { hash: l.hash, author: l.author, date: l.date, lineCount: 0, subject: '' }
      entry.lineCount++
      byCommit.set(l.hash, entry)
    }
    const commits = [...byCommit.values()].sort((a, b) => b.lineCount - a.lineCount)
    // attach subjects
    for (const c of commits) {
      try {
        const subject = git(repoPath, `log -1 --pretty=%s ${c.hash}`).trim()
        c.subject = subject
      } catch { /* ignore */ }
    }
    return { lines, commits }
  } catch {
    return null
  }
}

export function getDiff(repoPath: string, from: string, to: string): string {
  try {
    return git(repoPath, `diff ${from} ${to}`)
  } catch {
    return ''
  }
}

export function showCommit(repoPath: string, hash: string): { commit: CommitInfo | null; diff: string } {
  try {
    const format = '%H%x1f%h%x1f%an%x1f%aI%x1f%s%x1f%b'
    // JSON.stringify → double quotes: portable across /bin/sh AND cmd.exe
    const out = git(repoPath, `log -1 --pretty=format:${JSON.stringify(format)} ${hash}`)
    const [h, sh, an, aI, s, b] = out.split('\x1f')
    const diff = git(repoPath, `show --format= ${hash}`)
    return {
      commit: { hash: h, shortHash: sh, author: an, date: aI, subject: s, body: b || '', files: [] },
      diff,
    }
  } catch {
    return { commit: null, diff: '' }
  }
}

/** When was each line last touched, and by which commit — for "why does this code exist" investigation. */
export function suspiciousCodeInvestigation(
  repoPath: string,
  relFile: string,
  lineRange: { start: number; end: number }
): { found: boolean; commit: CommitInfo | null; context: string } {
  const blame = blameFile(repoPath, relFile, lineRange.start, lineRange.end)
  if (!blame || blame.commits.length === 0) return { found: false, commit: null, context: '' }
  const dominant = blame.commits[0]
  const log = getLog(repoPath, { limit: 200 })
  const commit = log.find((c) => c.hash === dominant.hash) || null
  const context = commit
    ? `Lines ${lineRange.start}-${lineRange.end} of ${relFile} last changed in ${commit.shortHash} "${commit.subject}" by ${commit.author} (${commit.date}). ${commit.body || ''}`
    : `Lines ${lineRange.start}-${lineRange.end} of ${relFile} dominated by ${dominant.hash.slice(0, 8)} (${dominant.author}).`
  return { found: true, commit, context }
}
