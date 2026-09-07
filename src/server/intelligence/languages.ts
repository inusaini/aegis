// Language detection and file classification for repository intelligence.

export interface LanguageInfo {
  language: string // canonical name: javascript | typescript | python | ...
  treeSitter: boolean // whether tree-sitter parsing is available
  extensions: string[]
}

export const LANGUAGES: Record<string, LanguageInfo> = {
  javascript: { language: 'javascript', treeSitter: true, extensions: ['js', 'mjs', 'cjs'] },
  typescript: { language: 'typescript', treeSitter: true, extensions: ['ts'] },
  tsx: { language: 'tsx', treeSitter: true, extensions: ['tsx'] },
  python: { language: 'python', treeSitter: true, extensions: ['py'] },
}

const EXT_TO_LANG: Record<string, string> = {}
for (const info of Object.values(LANGUAGES)) {
  for (const ext of info.extensions) EXT_TO_LANG[ext] = info.language
}

// Extra languages recognized for counting/overview but not parsed by tree-sitter (regex fallback exists for a few)
const EXTRA_LANGS: Record<string, string[]> = {
  json: ['json'],
  yaml: ['yml', 'yaml'],
  toml: ['toml'],
  markdown: ['md', 'mdx'],
  sql: ['sql'],
  html: ['html', 'htm'],
  css: ['css', 'scss', 'less'],
  shell: ['sh', 'bash'],
  go: ['go'],
  rust: ['rs'],
  java: ['java'],
  ruby: ['rb'],
  php: ['php'],
  c: ['c', 'h'],
  cpp: ['cpp', 'cc', 'hpp', 'cxx'],
}

export function detectLanguage(filePath: string): string {
  const ext = filePath.split('.').pop()?.toLowerCase() || ''
  if (EXT_TO_LANG[ext]) return EXT_TO_LANG[ext]
  for (const [lang, exts] of Object.entries(EXTRA_LANGS)) {
    if (exts.includes(ext)) return lang
  }
  if (!ext) return 'unknown'
  return 'unknown'
}

export function isTreeSitterLang(lang: string): boolean {
  return LANGUAGES[lang]?.treeSitter ?? false
}

export function isTestPath(path: string): boolean {
  const p = path.toLowerCase()
  return (
    p.includes('.test.') ||
    p.includes('.spec.') ||
    p.includes('/test/') ||
    p.startsWith('test/') ||
    p.includes('/tests/') ||
    p.startsWith('tests/') ||
    p.includes('__tests__/') ||
    p.endsWith('_test.py') ||
    p.endsWith('_test.go')
  )
}

export function isDocPath(path: string): boolean {
  const p = path.toLowerCase()
  return p.endsWith('.md') || p.endsWith('.mdx') || p.endsWith('.rst') || p.endsWith('.txt') || p.endsWith('README')
}

export function isConfigPath(path: string): boolean {
  const base = path.split('/').pop() || ''
  return (
    base === 'package.json' ||
    base === 'package-lock.json' ||
    base === 'requirements.txt' ||
    base === 'pyproject.toml' ||
    base === 'setup.py' ||
    base === 'Cargo.toml' ||
    base === 'go.mod' ||
    base === 'Dockerfile' ||
    base === 'docker-compose.yml' ||
    base === 'tsconfig.json' ||
    base === '.eslintrc.json' ||
    base === '.eslintrc.js' ||
    base.startsWith('.env') ||
    base === 'Caddyfile' ||
    base === 'next.config.js' ||
    base === 'next.config.ts' ||
    base === 'jest.config.js' ||
    base === 'vitest.config.ts'
  )
}

/** Directories that are never indexed. */
export const IGNORED_DIRS = new Set([
  'node_modules', '.git', '.next', 'dist', 'build', 'out', 'coverage',
  '.venv', 'venv', '__pycache__', '.tox', '.mypy_cache', '.pytest_cache',
  'target', 'vendor', '.idea', '.vscode', '.turbo', '.cache', '.agent-data',
])

/** Derive a logical module name from a file path: src/services/paymentService.js -> services */
export function deriveModule(path: string): string {
  const parts = path.split('/')
  if (parts.length <= 1) return 'root'
  // drop filename
  const dirs = parts.slice(0, -1).filter((d) => d !== '.')
  if (dirs.length === 0) return 'root'
  // skip leading src/app/lib/main
  const skip = new Set(['src', 'app', 'lib', 'main', 'internal'])
  const meaningful = dirs.filter((d) => !skip.has(d))
  return meaningful.length ? meaningful.join('/') : dirs[dirs.length - 1]
}
