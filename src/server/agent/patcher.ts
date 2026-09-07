// ============================================================
// Patch application: unified diffs are applied with `git apply`
// inside the workspace (git's own battle-tested patch engine).
// Malformed patches are reported, never guessed at.
// ============================================================

import fs from 'fs'
import path from 'path'
import { shSync } from '../sandbox/shell'
import type { ToolResult } from './tools'

function sh(cmd: string, cwd: string, timeout = 60_000): { ok: boolean; out: string } {
  // Cross-platform shell (cmd.exe on Windows / /bin/sh on POSIX)
  try {
    const out = shSync(cmd, { cwd, timeout })
    return { ok: true, out }
  } catch (err: any) {
    return { ok: false, out: (err?.stdout || '') + (err?.stderr || '') + (err?.message || '') }
  }
}

/** Files touched by a unified diff (---/+++ headers). */
export function filesInPatch(patch: string): string[] {
  const files: string[] = []
  for (const line of patch.split('\n')) {
    const m = line.match(/^\+\+\+\s+(?:b\/)?(.+)$/)
    if (m && m[1] && m[1] !== '/dev/null') files.push(m[1].trim())
  }
  return [...new Set(files)]
}

/** Strip markdown fences the model may have wrapped the patch in. */
export function cleanPatch(raw: string): string {
  let patch = raw.trim()
  const fence = patch.match(/```(?:diff|patch)?\n([\s\S]*?)```/)
  if (fence) patch = fence[1].trim()
  // drop leading commentary before the first diff header
  const firstHeader = patch.search(/^(---|diff --git)/m)
  if (firstHeader > 0) patch = patch.slice(firstHeader)
  return patch
}

export async function applyUnifiedPatch(workspacePath: string, rawPatch: string): Promise<ToolResult & { files: string[]; error?: string }> {
  const patch = cleanPatch(rawPatch)
  const files = filesInPatch(patch)
  if (!patch || files.length === 0) {
    return { ok: false, output: 'patch contains no diff headers', files: [], error: 'no diff headers' }
  }

  // git apply --check first: validate without touching the tree.
  // The patch file lives OUTSIDE the workspace so it never pollutes git status.
  const tmpFile = path.join(workspacePath, '..', 'agent-patch.diff')
  fs.mkdirSync(path.dirname(tmpFile), { recursive: true })
  fs.writeFileSync(tmpFile, patch)
  const absArg = JSON.stringify(path.resolve(tmpFile))
  const check = sh(`git apply --check --whitespace=nowarn ${absArg}`, workspacePath)
  if (!check.ok) {
    return {
      ok: false,
      output: `patch validation failed:\n${check.out.slice(0, 2000)}`,
      files,
      error: check.out.slice(0, 500),
    }
  }
  const apply = sh(`git apply --whitespace=nowarn ${absArg}`, workspacePath)
  fs.rmSync(tmpFile, { force: true })
  if (!apply.ok) {
    return { ok: false, output: `git apply failed:\n${apply.out.slice(0, 2000)}`, files, error: apply.out.slice(0, 500) }
  }
  return { ok: true, output: `patch applied to ${files.length} file(s): ${files.join(', ')}`, files }
}
