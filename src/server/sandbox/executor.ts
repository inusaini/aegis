// ============================================================
// Sandbox executor (spec §12): runs commands inside an isolated
// workspace with an allowlist of binaries, argument screening,
// timeouts, output caps, and a clean environment. No host env
// vars (secrets) ever pass through.
//
// Cross-platform: POSIX runs a bash/sh wrapper with ulimits;
// Windows runs cmd.exe (no ulimits there — timeouts + output
// caps + allowlist still apply). The interface is identical.
// In production this layer maps 1:1 onto a Docker container
// runtime — the interface stays the same.
// ============================================================

import { spawn, spawnSync } from 'child_process'
import path from 'path'
import { IS_WINDOWS, minimalEnv, sandboxHomeFor } from './shell'

export interface ExecOptions {
  cwd: string
  timeoutMs?: number
  /** extra env vars, explicitly whitelisted by the caller */
  env?: Record<string, string>
  maxOutputBytes?: number
}

export interface ExecResult {
  command: string
  exitCode: number | null
  stdout: string
  stderr: string
  durationMs: number
  timedOut: boolean
  blocked?: string
}

// Binaries the agent may execute. Everything else is rejected.
const ALLOWED_BINARIES = new Set([
  'node', 'bun', 'npm', 'npx', 'pnpm', 'yarn', 'tsc', 'eslint', 'prettier',
  'jest', 'vitest', 'mocha', 'pytest', 'python', 'python3', 'pip',
  'git', 'ls', 'cat', 'head', 'tail', 'wc', 'grep', 'rg', 'find', 'echo',
  'mkdir', 'cp', 'mv', 'touch', 'diff', 'sed', 'awk', 'sort', 'uniq',
])

// Windows resolves binaries through PATHEXT (node → node.exe,
// npm → npm.cmd). Normalize before the allowlist check.
const WIN_EXEC_EXT = /\.(exe|cmd|bat|com|ps1)$/i

// Substrings that make even an allowed command dangerous.
const FORBIDDEN_PATTERNS = [
  /\brm\s+-rf?\s+[/~]/,             // rm -rf /
  /\bcurl\b/, /\bwget\b/,            // network fetch
  /\bsudo\b/, /\bsu\b/,              // privilege escalation
  /\bssh\b/, /\bscp\b/, /\brsync\b/, // remote access
  /\bchmod\s+777\b/, /\bchown\b/,    // permissions abuse
  /\bmkfs\b/, /\bshutdown\b/, /\breboot\b/,
  /\/etc\/|\/root\/|\/home\/(?!z\/)/, // outside workspace paths (checked loosely)
  /\b[A-Za-z]:[\\/]/,                // absolute Windows drive paths — workspace-relative only
  /\benv\b\s*$/i,                    // dump env
  /\bprintenv\b/, /\bhistory\b/,
  /&&|\|\||\||&|;|\n/,               // chaining/piping — one plain command per call
  /`|\$\(/,                          // command substitution
]

export function screenCommand(command: string): { ok: boolean; reason?: string; binary: string; args: string[] } {
  const trimmed = command.trim()
  if (!trimmed) return { ok: false, reason: 'empty command', binary: '', args: [] }
  if (/[\n]/.test(trimmed)) return { ok: false, reason: 'multi-line commands are not allowed', binary: '', args: [] }
  if (FORBIDDEN_PATTERNS.some((p) => p.test(trimmed))) {
    return { ok: false, reason: `command matches a forbidden pattern (${trimmed.slice(0, 60)})`, binary: '', args: [] }
  }
  // tokenise respecting simple quotes
  const tokens: string[] = []
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(trimmed))) tokens.push(m[1] ?? m[2] ?? m[3])
  if (tokens.length === 0) return { ok: false, reason: 'empty command', binary: '', args: [] }
  let binary = path.basename(tokens[0])
  if (IS_WINDOWS && WIN_EXEC_EXT.test(binary)) binary = binary.replace(WIN_EXEC_EXT, '')
  if (!ALLOWED_BINARIES.has(binary)) {
    return { ok: false, reason: `binary '${binary}' is not on the allowlist`, binary, args: [] }
  }
  return { ok: true, binary, args: tokens.slice(1) }
}

const OUTPUT_CAP = 200 * 1024 // 200KB

/** Kill a process tree. cmd.exe's children survive a direct kill on Windows. */
function killTree(pid: number | undefined) {
  if (!pid) return
  if (IS_WINDOWS) {
    try { spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true }) } catch { /* best effort */ }
  } else {
    try { process.kill(pid, 'SIGKILL') } catch { /* already gone */ }
  }
}

// One-time probe: is bash available? (minimal containers may only ship sh)
let bashAvailable: boolean | null = null
function hasBash(): boolean {
  if (bashAvailable === null) {
    bashAvailable = spawnSync('bash', ['-c', 'true'], { timeout: 5000 }).error === undefined
  }
  return bashAvailable
}

export async function execInSandbox(command: string, opts: ExecOptions): Promise<ExecResult> {
  const screen = screenCommand(command)
  const started = Date.now()
  const base: ExecResult = {
    command,
    exitCode: null,
    stdout: '',
    stderr: '',
    durationMs: 0,
    timedOut: false,
  }
  if (!screen.ok) {
    return { ...base, blocked: screen.reason, durationMs: Date.now() - started }
  }

  const timeoutMs = Math.min(opts.timeoutMs ?? 120_000, 300_000)
  // Clean environment: PATH + the variables the OS itself needs, nothing else.
  // HOME lives OUTSIDE the repository checkout so caches never pollute git status.
  const sandboxEnv = minimalEnv(sandboxHomeFor(opts.cwd), {
    NODE_ENV: 'test',
    NO_COLOR: '1',
    ...opts.env,
  })

  if (IS_WINDOWS) {
    // cmd.exe — no ulimits on this platform; timeouts + caps + allowlist apply.
    const comspec = process.env.ComSpec || 'cmd.exe'
    return new Promise<ExecResult>((resolve) => {
      const child = spawn(comspec, ['/d', '/s', '/c', command], {
        cwd: opts.cwd,
        env: sandboxEnv,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      })
      drainChild(child, base, started, timeoutMs, resolve)
    })
  }

  // POSIX: bash with ulimit wrapper when available, plain /bin/sh otherwise.
  return new Promise<ExecResult>((resolve) => {
    let file: string
    let args: string[]
    if (hasBash()) {
      // ulimit wrapper: CPU (seconds), memory (KB), file size (KB), no core dumps
      const wrapped = `ulimit -t 120 -v 4000000 -f 2097152 -c 0 2>/dev/null; exec ${command}`
      file = 'bash'
      args = ['-c', wrapped]
    } else {
      file = '/bin/sh'
      args = ['-c', command]
    }
    const child = spawn(file, args, {
      cwd: opts.cwd,
      env: sandboxEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    drainChild(child, base, started, timeoutMs, resolve)
  })
}

// ------------------------------------------------------------

type Child = ReturnType<typeof spawn>

function drainChild(
  child: Child,
  base: ExecResult,
  started: number,
  timeoutMs: number,
  resolve: (r: ExecResult) => void
) {
  let stdout = ''
  let stderr = ''
  let killed = false

  const timer = setTimeout(() => {
    killed = true
    killTree(child.pid)
    try { child.kill('SIGKILL') } catch { /* already gone */ }
  }, timeoutMs)

  child.stdout?.on('data', (d: Buffer) => {
    if (stdout.length < OUTPUT_CAP) stdout += d.toString('utf8', 0, OUTPUT_CAP - stdout.length)
  })
  child.stderr?.on('data', (d: Buffer) => {
    if (stderr.length < OUTPUT_CAP) stderr += d.toString('utf8', 0, OUTPUT_CAP - stderr.length)
  })

  child.on('error', (err) => {
    clearTimeout(timer)
    resolve({ ...base, stderr: stderr + String(err), durationMs: Date.now() - started })
  })
  child.on('close', (code) => {
    clearTimeout(timer)
    resolve({
      ...base,
      exitCode: killed ? 124 : code,
      stdout,
      stderr,
      durationMs: Date.now() - started,
      timedOut: killed,
    })
  })
}
