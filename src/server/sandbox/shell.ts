// ============================================================
// Cross-platform shell primitives.
//
// Why this exists: Bun's `execSync` resolves its default shell to
// `/bin/sh` even on Windows, where that path does not exist —
// producing `spawnSync /bin/sh ENOENT` the moment the agent shells
// out (git worktree, patches, tests). Instead we ALWAYS spawn an
// explicit shell binary: cmd.exe on Windows, /bin/sh on POSIX.
//
// Also provides a minimal, platform-appropriate environment so
// spawned git/node/npm processes work without leaking host
// credentials or user configuration.
// ============================================================

import { spawnSync } from 'child_process'
import fs from 'fs'
import path from 'path'

export const IS_WINDOWS = process.platform === 'win32'

/** The shell binary + args used to run a command line. */
export function shellSpec(): { file: string; args: string[] } {
  if (IS_WINDOWS) {
    const comspec = process.env.ComSpec || 'cmd.exe'
    return { file: comspec, args: ['/d', '/s', '/c'] }
  }
  return { file: '/bin/sh', args: ['-c'] }
}

/**
 * Minimal environment for sandboxed git/node processes.
 * PATH is inherited (it holds no secrets and is required to find
 * the toolchain on any machine). Windows additionally needs the
 * system variables every native binary depends on. Everything
 * else — credentials, API keys, user config — is dropped.
 */
export function minimalEnv(cwd: string, extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? '',
    HOME: cwd,
    LANG: 'C',
    GIT_TERMINAL_PROMPT: '0',
    GIT_CONFIG_NOSYSTEM: '1',
    ...extra,
  }
  if (IS_WINDOWS) {
    if (process.env.SystemRoot) env.SystemRoot = process.env.SystemRoot
    if (process.env.SYSTEMDRIVE) env.SYSTEMDRIVE = process.env.SYSTEMDRIVE
    if (process.env.ComSpec) env.COMSPEC = process.env.ComSpec
    if (process.env.PATHEXT) env.PATHEXT = process.env.PATHEXT
    if (process.env.TEMP) env.TEMP = process.env.TEMP
    if (process.env.TMP) env.TMP = process.env.TMP
    if (process.env.USERPROFILE) env.USERPROFILE = process.env.USERPROFILE
  }
  return env
}

export interface ShSyncOptions {
  cwd: string
  timeout?: number
  maxBuffer?: number
  env?: Record<string, string>
  /** merge minimalEnv() into the provided env (default: true) */
  minimal?: boolean
}

/**
 * Synchronous cross-platform shell execution, drop-in for
 * `execSync(cmd, { cwd, encoding: 'utf8', ... })`.
 * Returns stdout; throws an Error carrying .status/.stdout/.stderr
 * on non-zero exit (same shape callers expect from execSync).
 */
export function shSync(cmd: string, opts: ShSyncOptions): string {
  const spec = shellSpec()
  const env =
    opts.minimal === false
      ? opts.env
      : minimalEnv(opts.cwd, { ...(opts.env ?? {}) })
  const res = spawnSync(spec.file, [...spec.args, cmd], {
    cwd: opts.cwd,
    encoding: 'utf8',
    timeout: opts.timeout ?? 60_000,
    maxBuffer: opts.maxBuffer ?? 16 * 1024 * 1024,
    env,
    windowsHide: true,
  })
  if (res.error) throw res.error
  if (res.status !== 0) {
    const err: any = new Error(
      `Command failed (${res.status}): ${cmd}\n${(res.stderr || '').slice(0, 500)}`
    )
    err.status = res.status
    err.stdout = res.stdout ?? ''
    err.stderr = res.stderr ?? ''
    throw err
  }
  return res.stdout ?? ''
}

/**
 * A writable HOME directory OUTSIDE the repository checkout, so
 * git/npm cache files never pollute the workspace's git status.
 */
export function sandboxHomeFor(cwd: string): string {
  const home = path.join(path.dirname(path.resolve(cwd)), '.home')
  try { fs.mkdirSync(home, { recursive: true }) } catch { /* best effort */ }
  return home
}
