// ============================================================
// Hybrid retrieval (spec §6): combines
//   semantic (vector) + keyword + symbol + reference +
//   dependency-graph traversal + git history + tests
// into a focused, high-value context for the model —
// never the whole repository.
// ============================================================

import { db } from '@/lib/db'
import { RepoGraph } from './graph'
import { vectorSearch, embedText, cosine } from './semantic'
import * as git from './git'
import fs from 'fs'
import path from 'path'

export interface RetrievedChunk {
  source: 'symbol' | 'file' | 'doc' | 'git' | 'test' | 'keyword'
  path: string
  title: string
  content: string
  score: number
  reason: string
}

export interface RetrievalResult {
  query: string
  chunks: RetrievedChunk[]
  relevantFiles: string[]
  relevantSymbols: { qualifiedName: string; name: string; kind: string; file: string }[]
  neighborhood: string[] // files within 1-2 import hops of the seeds
  gitLeads: { file: string; commits: git.CommitInfo[] }[]
  coverage: { semantic: number; keyword: number; symbol: number; graph: number; git: number; tests: number }
}

const STOPWORDS = new Set(['add', 'fix', 'the', 'a', 'an', 'to', 'in', 'of', 'and', 'or', 'for', 'with', 'new', 'change', 'make', 'should', 'must', 'api', 'application', 'app', 'please', 'this', 'that', 'it', 'is', 'are', 'be', 'when', 'where', 'which'])

function keywords(task: string): string[] {
  return (task.toLowerCase().match(/[a-z][a-z0-9]+/g) || [])
    .filter((w) => w.length > 2 && !STOPWORDS.has(w))
    .slice(0, 24)
}

function camelSplits(word: string): string[] {
  return word.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase().split(/\s+/)
}

export async function hybridRetrieve(
  repositoryId: string,
  repoPath: string,
  task: string,
  opts: { maxFiles?: number; graph?: RepoGraph } = {}
): Promise<RetrievalResult> {
  const maxFiles = opts.maxFiles ?? 12
  const graph = opts.graph ?? await RepoGraph.load(repositoryId)
  const kws = keywords(task)
  const expanded = [...new Set<string>([...kws, ...kws.flatMap(camelSplits)])]
  const fileScores = new Map<string, { score: number; reasons: Set<string> }>()

  const bump = (file: string, score: number, reason: string) => {
    if (!file || file.startsWith('db:') || file.startsWith('external:')) return
    const rec = fileScores.get(file) || { score: 0, reasons: new Set<string>() }
    rec.score += score
    rec.reasons.add(reason)
    fileScores.set(file, rec)
  }

  // ---- 1. symbol retrieval ------------------------------------------
  const symbolHits: RetrievalResult['relevantSymbols'] = []
  for (const kw of expanded) {
    for (const sym of graph.findSymbol(kw)) {
      symbolHits.push({ qualifiedName: sym.qualifiedName, name: sym.name, kind: sym.kind, file: sym.file })
      bump(sym.file, 3, `symbol:${sym.kind}:${sym.name}`)
    }
  }

  // ---- 2. keyword search (filename + content grep, DB-backed) --------
  const allFiles = await db.file.findMany({ where: { repositoryId } })
  for (const f of allFiles) {
    const lower = f.path.toLowerCase()
    for (const kw of expanded) {
      if (lower.includes(kw)) bump(f.path, 2.5, 'filename-match')
    }
  }
  // content keyword search via LIKE on symbol names/doc comments (cheap approximation)
  for (const kw of expanded.slice(0, 8)) {
    const docMatches = await db.document.findMany({
      where: { repositoryId, OR: [{ title: { contains: kw } }, { content: { contains: kw } }] },
      select: { sourcePath: true },
      take: 40,
    })
    for (const d of docMatches) {
      if (d.sourcePath && !d.sourcePath.startsWith('git:')) bump(d.sourcePath, 1.5, 'doc-match')
    }
    const symbolMatches = await db.symbol.findMany({
      where: { repositoryId, OR: [{ name: { contains: kw } }, { docComment: { contains: kw } }] },
      select: { file: { select: { path: true } } },
      take: 40,
    })
    for (const s of symbolMatches) bump(s.file.path, 2, 'symbol-content-match')
  }

  // ---- 3. semantic retrieval ------------------------------------------
  const semanticHits = await vectorSearch(repositoryId, task, 8)
  for (const hit of semanticHits) {
    if (hit.doc.sourcePath && !hit.doc.sourcePath.startsWith('git:')) {
      bump(hit.doc.sourcePath, 1 + hit.score * 2, `semantic:${hit.doc.sourceType}`)
    }
    // commits reference files -> boost those
    if (hit.doc.sourcePath.startsWith('git:')) {
      const commit = git.getLog(repoPath, { limit: 60 }).find((c) => c.shortHash === hit.doc.sourcePath.slice(4))
      for (const f of commit?.files || []) bump(f, 1 + hit.score, `git-semantic:${hit.doc.sourceType}`)
    }
  }

  // ---- 4. tests channel ------------------------------------------------
  for (const f of allFiles) {
    if (!f.isTest) continue
    const lower = f.path.toLowerCase()
    if (expanded.some((kw) => lower.includes(kw))) bump(f.path, 1.5, 'test-file-match')
  }

  // ---- 5. seed files -> graph neighborhood --------------------------------
  const ranked = [...fileScores.entries()].sort((a, b) => b[1].score - a[1].score)
  const seeds = ranked.slice(0, maxFiles).map(([f]) => f)
  const neighborhood = new Set<string>()
  for (const seed of seeds) {
    for (const dep of graph.getDependencies(seed).local) {
      neighborhood.add(dep)
      bump(dep, 1.2, 'import-of-seed')
    }
    for (const imp of graph.getImporters(seed)) {
      neighborhood.add(imp)
      bump(imp, 1.5, 'importer-of-seed')
    }
    for (const t of graph.getRelatedTests(seed)) bump(t, 1.8, 'tests-seed')
  }
  for (const n of neighborhood) if (!fileScores.has(n)) bump(n, 1, 'neighborhood')

  // ---- 6. git history channel ------------------------------------------
  const gitLeads: RetrievalResult['gitLeads'] = []
  const topFiles = [...fileScores.entries()].sort((a, b) => b[1].score - a[1].score).slice(0, 6).map(([f]) => f)
  for (const f of topFiles) {
    const log = git.getLog(repoPath, { file: f, limit: 6 })
    if (log.length) {
      gitLeads.push({ file: f, commits: log })
      // commits that touched this file often also touched friends
      for (const c of log.slice(0, 3)) {
        for (const friend of c.files) bump(friend, 0.6, `co-changed-with:${f}`)
      }
    }
  }

  // ---- assemble context chunks -----------------------------------------
  const finalRanked = [...fileScores.entries()].sort((a, b) => b[1].score - a[1].score).slice(0, maxFiles + 6)
  const chunks: RetrievedChunk[] = []
  const relevantFiles: string[] = []

  for (const [file, rec] of finalRanked) {
    const abs = path.join(repoPath, file)
    let content = ''
    try {
      content = fs.readFileSync(abs, 'utf8').split('\n').slice(0, 220).join('\n')
    } catch { continue }
    relevantFiles.push(file)
    chunks.push({
      source: 'file',
      path: file,
      title: file,
      content,
      score: rec.score,
      reason: [...rec.reasons].slice(0, 4).join(', '),
    })
    const syms = graph.getFileSymbols(file)
    if (syms.length) {
      chunks.push({
        source: 'symbol',
        path: file,
        title: `${file} — ${syms.length} symbols`,
        content: syms.map((s) => `${s.kind} ${s.name} (L${s.lineStart}-${s.lineEnd})${s.docComment ? ' — ' + s.docComment.split('\n')[0] : ''}`).join('\n'),
        score: rec.score * 0.8,
        reason: 'symbol table',
      })
    }
  }

  for (const hit of semanticHits.slice(0, 4)) {
    if (hit.score > 0.15) {
      chunks.push({
        source: 'doc',
        path: hit.doc.sourcePath,
        title: hit.doc.title,
        content: hit.doc.content.slice(0, 1500),
        score: hit.score,
        reason: `semantic doc (${hit.doc.sourceType})`,
      })
    }
  }

  for (const lead of gitLeads.slice(0, 4)) {
    chunks.push({
      source: 'git',
      path: lead.file,
      title: `git history: ${lead.file}`,
      content: lead.commits.map((c) => `${c.shortHash} ${c.date?.slice(0, 10)} "${c.subject}"`).join('\n'),
      score: 1,
      reason: 'file history',
    })
  }

  // suspicious-code investigation: top symbols with legacy markers in docs
  for (const [file, rec] of finalRanked.slice(0, 5)) {
    const syms = graph.getFileSymbols(file)
    const suspicious = syms.filter((s) => /DO NOT|HACK|FIXME|XXX|legacy|workaround|deprecated|race/i.test(s.docComment))
    for (const s of suspicious.slice(0, 3)) {
      const inv = git.suspiciousCodeInvestigation(repoPath, file, { start: s.lineStart, end: Math.min(s.lineStart + 15, s.lineEnd) })
      if (inv.found && inv.commit) {
        chunks.push({
          source: 'git',
          path: file,
          title: `why does ${s.name} look like this? (${s.qualifiedName})`,
          content: inv.context,
          score: 2 + rec.score,
          reason: 'historical context for suspicious code',
        })
      }
    }
  }

  // tests content
  const testFiles = relevantFiles.filter((f) => f.includes('.test.') || f.includes('/tests/'))
  for (const t of testFiles.slice(0, 3)) {
    try {
      const content = fs.readFileSync(path.join(repoPath, t), 'utf8').split('\n').slice(0, 120).join('\n')
      chunks.push({ source: 'test', path: t, title: t, content, score: 1, reason: 'existing test coverage' })
    } catch { /* skip */ }
  }

  return {
    query: task,
    chunks,
    relevantFiles,
    relevantSymbols: dedupeSymbols(symbolHits).slice(0, 30),
    neighborhood: [...neighborhood].slice(0, 20),
    gitLeads,
    coverage: {
      semantic: semanticHits.length,
      keyword: kws.length,
      symbol: symbolHits.length,
      graph: neighborhood.size,
      git: gitLeads.reduce((s, l) => s + l.commits.length, 0),
      tests: testFiles.length,
    },
  }
}

function dedupeSymbols(syms: RetrievalResult['relevantSymbols']): RetrievalResult['relevantSymbols'] {
  const seen = new Set<string>()
  return syms.filter((s) => {
    if (seen.has(s.qualifiedName)) return false
    seen.add(s.qualifiedName)
    return true
  })
}
