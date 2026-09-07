// ============================================================
// Repository indexer: walks the working tree, parses each file,
// builds the file/symbol/relationship tables, collects semantic
// documents, and synthesizes the repository overview.
// ============================================================

import fs from 'fs'
import path from 'path'
import { db } from '@/lib/db'
import { parseCodeFile, type ParsedFile } from './parsers'
import { detectLanguage, isTestPath, isDocPath, isConfigPath, deriveModule, IGNORED_DIRS } from './languages'
import * as git from './git'
import { collectSemanticDocuments } from './semantic'
import { synthesizeOverview, type OverviewData } from './overview'

export interface IndexProgress {
  step: string
  percent: number
}

const MAX_FILES = 5000
const MAX_FILE_SIZE = 1024 * 1024 // 1MB
const SKIP_BINARY_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'ico', 'svg', 'webp', 'pdf', 'zip', 'gz', 'tar', 'woff', 'woff2', 'ttf', 'eot', 'mp4', 'mp3', 'wav', 'node', 'pyc', 'class', 'so', 'dylib', 'dll', 'exe', 'bin'])

interface WalkedFile {
  relPath: string
  absPath: string
  size: number
  language: string
  isTest: boolean
  isDoc: boolean
  isConfig: boolean
  mtime: string
}

function walkRepo(root: string): WalkedFile[] {
  const out: WalkedFile[] = []
  const queue: string[] = [root]
  while (queue.length > 0 && out.length < MAX_FILES) {
    const dir = queue.shift()!
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.') && entry.name !== '.github') continue
      const abs = path.join(dir, entry.name)
      const rel = path.relative(root, abs).split(path.sep).join('/')
      if (entry.isDirectory()) {
        if (IGNORED_DIRS.has(entry.name)) continue
        queue.push(abs)
      } else if (entry.isFile()) {
        const ext = entry.name.split('.').pop()?.toLowerCase() || ''
        if (SKIP_BINARY_EXT.has(ext)) continue
        let size = 0
        try {
          const st = fs.statSync(abs)
          size = st.size
          if (size > MAX_FILE_SIZE) continue
          out.push({
            relPath: rel,
            absPath: abs,
            size,
            language: detectLanguage(rel),
            isTest: isTestPath(rel),
            isDoc: isDocPath(rel),
            isConfig: isConfigPath(rel),
            mtime: st.mtime.toISOString(),
          })
        } catch { continue }
      }
    }
  }
  return out
}

/** Resolve a relative import specifier against the importing file. */
function resolveImport(fromFile: string, spec: string, allFiles: Set<string>): string | null {
  if (!spec.startsWith('.') && !spec.startsWith('/')) return null
  const base = path.posix.dirname(fromFile)
  const target = path.posix.normalize(path.posix.join(base, spec))
  const candidates = [
    target,
    `${target}.js`, `${target}.ts`, `${target}.tsx`, `${target}.jsx`, `${target}.mjs`, `${target}.cjs`, `${target}.py`,
    `${target}/index.js`, `${target}/index.ts`, `${target}/index.tsx`, `${target}/index.py`,
  ]
  for (const c of candidates) {
    if (allFiles.has(c)) return c
  }
  // try prefix match for directories (a/b -> a/b.js, a/b/index.js already covered)
  return null
}

/** Python module import -> file path, e.g. "src.services.payment" -> src/services/payment.py */
function resolvePythonImport(spec: string, allFiles: Set<string>): string | null {
  const parts = spec.split('.')
  for (let i = parts.length; i > 0; i--) {
    const prefix = parts.slice(0, i).join('/')
    const candidates = [`${prefix}.py`, `${prefix}/__init__.py`]
    for (const c of candidates) {
      if (allFiles.has(c)) return c
    }
  }
  return null
}

export interface IndexResult {
  files: number
  symbols: number
  relationships: number
  documents: number
  commits: number
  overview: OverviewData
  durationMs: number
}

export async function indexRepository(
  repositoryId: string,
  repoPath: string,
  onProgress?: (p: IndexProgress) => void
): Promise<IndexResult> {
  const startedAt = Date.now()
  const report = (step: string, percent: number) => onProgress?.({ step, percent })

  report('Walking repository files', 5)
  const walked = walkRepo(repoPath)
  const allFiles = new Set(walked.map((f) => f.relPath))

  // wipe previous index rows for this repository
  report('Clearing previous index', 8)
  await db.relationship.deleteMany({ where: { repositoryId } })
  await db.symbol.deleteMany({ where: { repositoryId } })
  await db.file.deleteMany({ where: { repositoryId } })
  await db.document.deleteMany({ where: { repositoryId } })

  // ---- parse phase -------------------------------------------------------
  const parsedByFile = new Map<string, ParsedFile>()
  const fileRows: { id: string; path: string }[] = []
  let processed = 0
  for (const f of walked) {
    processed++
    if (processed % 25 === 0) report(`Parsing ${f.relPath}`, 10 + Math.floor(70 * (processed / walked.length)))
    let content = ''
    try {
      content = fs.readFileSync(f.absPath, 'utf8')
    } catch { continue }
    const parsed = parseCodeFile(f.relPath, content, f.language)
    parsedByFile.set(f.relPath, parsed)

    const fileRow = await db.file.create({
      data: {
        repositoryId,
        path: f.relPath,
        language: f.language,
        sizeBytes: f.size,
        loc: content.split('\n').length,
        isTest: f.isTest,
        isConfig: f.isConfig,
        isDoc: f.isDoc,
        module: deriveModule(f.relPath),
        lastModified: f.mtime,
        symbols: {
          create: parsed.symbols.map((s) => ({
            repositoryId,
            name: s.name,
            qualifiedName: s.qualifiedName,
            kind: s.kind,
            signature: s.signature,
            lineStart: s.lineStart,
            lineEnd: s.lineEnd,
            exported: s.exported,
            docComment: s.docComment,
            metadata: JSON.stringify(s.metadata || {}),
          })),
        },
      },
    })
    fileRows.push({ id: fileRow.id, path: f.relPath })
  }

  // route symbols: express-style routes as file-level symbols
  const routeSymbols: { repositoryId: string; fileId: string; name: string; qualifiedName: string; kind: string; lineStart: number; signature: string }[] = []
  for (const [rel, parsed] of parsedByFile) {
    for (const r of parsed.routes) {
      const fileRow = fileRows.find((fr) => fr.path === rel)
      if (!fileRow) continue
      routeSymbols.push({
        repositoryId,
        fileId: fileRow.id,
        name: `${r.method} ${r.path}`,
        qualifiedName: `${rel}::route ${r.method} ${r.path}`,
        kind: 'route',
        lineStart: r.line,
        signature: `${r.method} ${r.path}`,
      })
    }
  }
  if (routeSymbols.length) {
    await db.symbol.createMany({ data: routeSymbols })
  }

  // ---- relationship resolution -------------------------------------------
  report('Resolving dependency relationships', 82)
  const symbolIndex = new Map<string, { qualifiedName: string; file: string }[]>() // name -> symbols
  for (const [rel, parsed] of parsedByFile) {
    for (const s of parsed.symbols) {
      const arr = symbolIndex.get(s.name) || []
      arr.push({ qualifiedName: s.qualifiedName, file: rel })
      symbolIndex.set(s.name, arr)
    }
  }

  const rels: { repositoryId: string; kind: string; fromFile: string; fromSymbol: string; toFile: string; toSymbol: string }[] = []
  const seenRel = new Set<string>()
  const addRel = (kind: string, fromFile: string, fromSymbol: string, toFile: string, toSymbol = '') => {
    const key = `${kind}|${fromFile}|${fromSymbol}|${toFile}|${toSymbol}`
    if (seenRel.has(key)) return
    seenRel.add(key)
    rels.push({ repositoryId, kind, fromFile, fromSymbol, toFile, toSymbol })
  }

  for (const [rel, parsed] of parsedByFile) {
    // imports -> local files or external packages
    const importedLocal = new Set<string>()
    for (const im of parsed.imports) {
      const isRelative = im.specifier.startsWith('.')
      const resolved = isRelative ? resolveImport(rel, im.specifier, allFiles) : null
      const pyResolved = !resolved ? resolvePythonImport(im.specifier, allFiles) : null
      if (resolved) {
        importedLocal.add(resolved)
        addRel('IMPORTS', rel, '', resolved)
      } else if (pyResolved) {
        importedLocal.add(pyResolved)
        addRel('IMPORTS', rel, '', pyResolved)
      } else if (!isRelative && /^[a-z@][\w@/.-]*$/i.test(im.specifier)) {
        // external package (first segment)
        const pkg = im.specifier.startsWith('@') ? im.specifier.split('/').slice(0, 2).join('/') : im.specifier.split('/')[0]
        if (!['fs', 'path', 'http', 'crypto', 'os', 'util', 'url', 'events', 'stream', 'child_process', 'node'].includes(pkg)) {
          addRel('DEPENDS_ON', rel, '', `external:${pkg}`)
        }
      }
    }

    // calls -> resolved through imported files' symbols
    const importCandidates = [...importedLocal]
    for (const call of parsed.calls) {
      const targets = symbolIndex.get(call.name) || []
      const resolved = targets.filter((t) => t.file !== rel)
      if (resolved.length === 0) continue
      // prefer symbols in files imported by this file; fall back to any unique match
      const inImports = resolved.filter((t) => importedLocal.has(t.file))
      const chosen = inImports.length > 0 ? inImports : resolved.length <= 2 ? resolved : []
      for (const t of chosen) {
        addRel('CALLS', rel, call.context ? `${rel}::${call.context}` : '', t.file, t.qualifiedName)
      }
    }

    // database access
    for (const dba of parsed.dbTables) {
      addRel(dba.access === 'reads' ? 'READS' : 'WRITES', rel, '', `db:${dba.table}`)
    }

    // test files test the modules they import
    if (isTestPath(rel)) {
      for (const target of importedLocal) {
        addRel('TESTS', rel, '', target)
      }
    }
  }

  // ---- git history + semantic documents ----------------------------------
  report('Indexing git history and documents', 88)
  const commits = git.isGitRepo(repoPath) ? git.getLog(repoPath, { limit: 200 }) : []
  const documents = await collectSemanticDocuments(repoPath, parsedByFile, commits, fileRows)

  // ---- persist relationships + documents ----------------------------------
  report('Persisting index', 92)
  for (let i = 0; i < rels.length; i += 500) {
    await db.relationship.createMany({ data: rels.slice(i, i + 500) })
  }
  for (let i = 0; i < documents.length; i += 100) {
    await db.document.createMany({
      data: documents.slice(i, i + 100).map((d) => ({
        repositoryId,
        sourceType: d.sourceType,
        sourcePath: d.sourcePath,
        title: d.title,
        content: d.content,
        embedding: d.embedding,
        chunkIndex: d.chunkIndex,
      })),
    })
  }

  // ---- overview synthesis -------------------------------------------------
  report('Synthesizing repository overview', 96)
  const symbolCount = await db.symbol.count({ where: { repositoryId } })
  const overview = synthesizeOverview(repoPath, walked, parsedByFile, commits)

  // update repository + analysis rows
  const defaultBranch = git.isGitRepo(repoPath) ? git.getDefaultBranch(repoPath) : 'main'
  const head = git.getHeadCommit(repoPath)
  await db.repository.update({
    where: { id: repositoryId },
    data: {
      analysisStatus: 'ready',
      lastIndexedAt: new Date(),
      fileCount: walked.length,
      sizeKb: Math.round(walked.reduce((s, f) => s + f.size, 0) / 1024),
      defaultBranch,
      headCommit: head,
      branch: defaultBranch,
      analysis: {
        upsert: {
          create: {
            status: 'completed',
            completedAt: new Date(),
            overview: JSON.stringify(overview),
            progress: 100,
            progressStep: 'done',
          },
          update: {
            status: 'completed',
            completedAt: new Date(),
            overview: JSON.stringify(overview),
            progress: 100,
            progressStep: 'done',
          },
        },
      },
    },
  })

  return {
    files: walked.length,
    symbols: symbolCount,
    relationships: rels.length,
    documents: documents.length,
    commits: commits.length,
    overview,
    durationMs: Date.now() - startedAt,
  }
}
