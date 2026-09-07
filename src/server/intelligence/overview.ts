// ============================================================
// Repository overview synthesis: frameworks, dependencies,
// database, test frameworks, services, entry points, and a
// heuristic architecture summary built from indexed evidence.
// (The agent's UNDERSTANDING phase enriches this with LLM
// narrative when a provider is available.)
// ============================================================

import fs from 'fs'
import path from 'path'
import type { ParsedFile } from './parsers'
import type { CommitInfo } from './git'
import type { WalkedFile } from './indexer'

export interface OverviewData {
  languages: { name: string; files: number; loc: number; share: number }[]
  frameworks: string[]
  testFrameworks: string[]
  database: { detected: string; details: string[]; tables: string[]; accessLayers: string[] }
  dependencies: { name: string; version: string; type: string }[]
  importantDirectories: { path: string; purpose: string }[]
  services: string[]
  entryPoints: string[]
  architectureSummary: string
  stats: { files: number; symbols: number; relationships: number; documents: number; commits: number }
}

const FRAMEWORK_SIGNATURES: Record<string, string[]> = {
  express: ['express'],
  'next.js': ['next'],
  nestjs: ['@nestjs/core'],
  fastapi: ['fastapi'],
  flask: ['flask'],
  django: ['django'],
  react: ['react'],
  vue: ['vue'],
  angular: ['@angular/core'],
  prisma: ['@prisma/client', 'prisma'],
  sequelize: ['sequelize'],
  mongoose: ['mongoose'],
  typeorm: ['typeorm'],
  jest: ['jest'],
  vitest: ['vitest'],
  mocha: ['mocha'],
  pytest: ['pytest'],
  unittest: ['unittest'],
  eslint: ['eslint'],
  typescript: ['typescript'],
}

function readJson(file: string): any | null {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

function readRequirements(file: string): { name: string; version: string }[] {
  try {
    const lines = fs.readFileSync(file, 'utf8').split('\n')
    return lines
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('#'))
      .map((l) => {
        const m = l.match(/^([A-Za-z0-9_.-]+)\s*(?:==|>=|<=|~=|>)\s*([^\s,]+)/)
        return m ? { name: m[1].toLowerCase().replace(/-/g, ''), version: m[2] } : { name: l.toLowerCase(), version: '*' }
      })
  } catch {
    return []
  }
}

function purposeFor(dir: string): string {
  const d = dir.toLowerCase()
  if (d.includes('route') || d.includes('controller')) return 'API route handlers'
  if (d.includes('service') || d.includes('usecase') || d.includes('domain')) return 'Business logic services'
  if (d.includes('repo') || d.includes('db') || d.includes('database') || d.includes('model') || d.includes('dao')) return 'Data access layer'
  if (d.includes('lib') || d.includes('util')) return 'Shared utilities'
  if (d.includes('config') || d.includes('settings')) return 'Configuration'
  if (d.includes('test') || d.includes('spec')) return 'Tests'
  if (d.includes('middleware') || d.includes('interceptor')) return 'Middleware'
  if (d.includes('component') || d.includes('view') || d.includes('page') || d.includes('ui')) return 'UI components'
  if (d.includes('doc')) return 'Documentation'
  if (d.includes('script') || d.includes('bin')) return 'Operational scripts'
  if (d.includes('app') || d.includes('src') || d.includes('main')) return 'Application source'
  return 'Module'
}

export function synthesizeOverview(
  repoPath: string,
  walked: WalkedFile[],
  parsedByFile: Map<string, ParsedFile>,
  commits: CommitInfo[]
): OverviewData {
  // ---- languages -----------------------------------------------------
  const byLang = new Map<string, { files: number; loc: number }>()
  for (const f of walked) {
    const rec = byLang.get(f.language) || { files: 0, loc: 0 }
    rec.files++
    if (!f.isDoc && !f.isConfig) {
      try {
        rec.loc += fs.readFileSync(f.absPath, 'utf8').split('\n').length
      } catch { /* skip */ }
    }
    byLang.set(f.language, rec)
  }
  const totalFiles = walked.length || 1
  const languages = [...byLang.entries()]
    .map(([name, v]) => ({ name, files: v.files, loc: v.loc, share: Math.round((v.files / totalFiles) * 100) }))
    .sort((a, b) => b.files - a.files)

  // ---- dependencies ---------------------------------------------------
  const deps: OverviewData['dependencies'] = []
  const pkg = readJson(path.join(repoPath, 'package.json'))
  if (pkg) {
    for (const [name, version] of Object.entries(pkg.dependencies || {})) deps.push({ name, version: String(version), type: 'runtime' })
    for (const [name, version] of Object.entries(pkg.devDependencies || {})) deps.push({ name, version: String(version), type: 'dev' })
  }
  const reqs = readRequirements(path.join(repoPath, 'requirements.txt'))
  for (const r of reqs) deps.push({ name: r.name, version: r.version, type: 'runtime' })
  const pyproject = readJson(path.join(repoPath, 'pyproject.toml')) // toml isn't JSON; regex fallback below
  void pyproject
  if (deps.length === 0) {
    try {
      const toml = fs.readFileSync(path.join(repoPath, 'pyproject.toml'), 'utf8')
      for (const m of toml.matchAll(/^\s*([a-z0-9_-]+)\s*=\s*["'][^"']*["']/gim)) {
        deps.push({ name: m[1].toLowerCase(), version: '*', type: 'runtime' })
      }
    } catch { /* skip */ }
  }

  // ---- frameworks & test frameworks ------------------------------------
  const depNames = new Set(deps.map((d) => d.name.replace(/@types\//, '')))
  const frameworks: string[] = []
  const testFrameworks: string[] = []
  for (const [fw, sigs] of Object.entries(FRAMEWORK_SIGNATURES)) {
    if (sigs.some((s) => depNames.has(s))) {
      if (['jest', 'vitest', 'mocha', 'pytest', 'unittest'].includes(fw)) testFrameworks.push(fw)
      else frameworks.push(fw)
    }
  }
  // heuristic test framework detection from file patterns
  const hasNodeTest = [...parsedByFile.keys()].some((p) => p.includes('.test.') || p.includes('.spec.'))
  if (hasNodeTest && testFrameworks.length === 0 && depNames.size === 0) testFrameworks.push('node:test')
  const hasPyTest = [...parsedByFile.keys()].some((p) => p.endsWith('_test.py') || p.includes('test_'))
  if (hasPyTest && !testFrameworks.includes('pytest')) testFrameworks.push('pytest-style')

  // ---- database ---------------------------------------------------------
  const dbDetails: string[] = []
  const tables = new Set<string>()
  const accessLayers = new Set<string>()
  let detected = 'none detected'
  if (depNames.has('pg') || fs.existsSync(path.join(repoPath, 'prisma/schema.prisma'))) {
    detected = 'PostgreSQL (Prisma or pg driver)'
    dbDetails.push('Prisma schema or pg driver detected in dependencies')
  }
  if (depNames.has('mysql') || depNames.has('mysql2')) { detected = 'MySQL'; dbDetails.push('mysql/mysql2 driver in dependencies') }
  if (depNames.has('sqlite3') || depNames.has('better-sqlite3')) { detected = 'SQLite'; dbDetails.push('SQLite driver in dependencies') }
  if (depNames.has('mongoose')) { detected = 'MongoDB'; dbDetails.push('Mongoose ODM in dependencies') }

  // evidence from code: SQL strings, db.read/write patterns, .json data files
  for (const [rel, parsed] of parsedByFile) {
    for (const t of parsed.dbTables) {
      tables.add(t.table)
      accessLayers.add(rel)
    }
  }
  // prisma models
  try {
    const schema = fs.readFileSync(path.join(repoPath, 'prisma/schema.prisma'), 'utf8')
    for (const m of schema.matchAll(/^model\s+(\w+)\s*\{/gm)) {
      tables.add(m[1])
      accessLayers.add('prisma/schema.prisma')
    }
    if (detected === 'none detected' && tables.size > 0) detected = 'Prisma models detected'
  } catch { /* no prisma */ }

  // JSON data files as a naive store (legacy pattern)
  const jsonDbFiles = walked.filter((f) => f.relPath.match(/\/(data|db|fixtures|seed)s?\//) && f.relPath.endsWith('.json'))
  for (const f of jsonDbFiles) {
    tables.add(f.relPath.split('/').pop()!.replace(/\.json$/, ''))
    accessLayers.add(f.relPath)
  }
  if (detected === 'none detected' && (tables.size > 0 || jsonDbFiles.length > 0)) {
    detected = 'JSON file store (legacy pattern)'
    dbDetails.push('JSON files under data/db directories used as persistence')
  }
  if (tables.size) dbDetails.push(`Tables/collections referenced: ${[...tables].slice(0, 15).join(', ')}`)

  // ---- important directories ---------------------------------------------
  const dirCount = new Map<string, number>()
  for (const f of walked) {
    const dir = path.posix.dirname(f.relPath)
    if (dir === '.') continue
    const top = dir.split('/').slice(0, 2).join('/')
    dirCount.set(top, (dirCount.get(top) || 0) + 1)
  }
  const importantDirectories = [...dirCount.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 12)
    .map(([dir, count]) => ({ path: dir, purpose: `${purposeFor(dir)} (${count} files)` }))

  // ---- services & entry points ---------------------------------------------
  const services = [...new Set(
    walked
      .filter((f) => /\/(services?|modules?|domains?)\//.test(f.relPath) || f.relPath.includes('Service.'))
      .map((f) => {
        const name = f.relPath.split('/').pop()!.replace(/\.(js|ts|tsx|py)$/, '')
        const dir = path.posix.dirname(f.relPath).split('/').pop()
        return dir && /service|module|domain/.test(dir) ? `${name} (${dir})` : name
      })
  )].slice(0, 20)

  const entryPoints: string[] = []
  if (pkg?.main) entryPoints.push(String(pkg.main))
  for (const candidate of ['src/index.js', 'src/index.ts', 'src/app.js', 'src/main.py', 'src/server.js', 'app.py', 'main.py', 'index.js', 'index.ts']) {
    if (allFilesSet(walked).has(candidate) && !entryPoints.includes(candidate)) entryPoints.push(candidate)
  }

  // ---- architecture summary ------------------------------------------------
  const archBits: string[] = []
  const primary = languages[0]?.name || 'unknown'
  archBits.push(`Primarily ${primary} (${languages[0]?.files || 0} files)`)
  if (frameworks.length) archBits.push(`built with ${frameworks.slice(0, 3).join(', ')}`)
  if (services.length) archBits.push(`business logic in ${services.length} service module(s) (${services.slice(0, 3).map((s) => s.split(' ')[0]).join(', ')})`)
  if (entryPoints.length) archBits.push(`entry point(s): ${entryPoints.slice(0, 2).join(', ')}`)
  if (detected !== 'none detected') archBits.push(`persists to ${detected}`)
  if (testFrameworks.length) archBits.push(`tested with ${testFrameworks.join(', ')}`)
  if (commits.length) {
    const years = commits.map((c) => c.date?.slice(0, 4)).filter(Boolean)
    const span = years.length ? `${Math.min(...years.map(Number))}–${Math.max(...years.map(Number))}` : 'unknown'
    archBits.push(`${commits.length} indexed commits spanning ${span}`)
  }
  const noDeps = deps.length === 0 && [...parsedByFile.keys()].length > 0
  if (noDeps) archBits.push('zero external runtime dependencies — hand-rolled infrastructure')

  const architectureSummary = archBits.join('; ') + '.'

  return {
    languages,
    frameworks,
    testFrameworks,
    database: { detected, details: dbDetails, tables: [...tables].slice(0, 25), accessLayers: [...accessLayers].slice(0, 15) },
    dependencies: deps.slice(0, 40),
    importantDirectories,
    services,
    entryPoints,
    architectureSummary,
    stats: {
      files: walked.length,
      symbols: [...parsedByFile.values()].reduce((s, p) => s + p.symbols.length, 0),
      relationships: 0, // filled by caller
      documents: 0, // filled by caller
      commits: commits.length,
    },
  }
}

function allFilesSet(walked: WalkedFile[]): Set<string> {
  return new Set(walked.map((f) => f.relPath))
}
