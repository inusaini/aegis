// ============================================================
// Semantic index: natural-language documents (README, docs,
// comments, commit messages, test descriptions) embedded with a
// local deterministic vectorizer. The embedding model role in the
// LLM abstraction delegates here by default (the z-ai SDK has no
// embeddings endpoint); swap in a real embedding provider later
// without touching callers.
// ============================================================

import fs from 'fs'
import path from 'path'
import type { ParsedFile } from './parsers'
import type { CommitInfo } from './git'

export interface SemanticDoc {
  repositoryId?: string
  sourceType: 'readme' | 'doc' | 'comment' | 'commit' | 'test' | 'issue' | 'config'
  sourcePath: string
  title: string
  content: string
  embedding: string
  chunkIndex: number
}

// ------------------------------------------------------------
// Local deterministic embedder: hashed bag-of-words + bigrams.
// 384 dimensions, L2-normalized. Zero network, zero API cost,
// stable across runs. Not deep semantics — but the hybrid
// retrieval pipeline combines it with symbol/graph/git channels.
// ------------------------------------------------------------

export const EMBED_DIM = 384

function tokenize(text: string): string[] {
  const lower = text.toLowerCase()
  const words = lower.match(/[a-z][a-z0-9]*/g) || []
  // camelCase / snake_case splitting
  const split: string[] = []
  for (const w of words) {
    const parts = w.split(/[_]/).flatMap((p) => p.replace(/([a-z])([A-Z])/g, '$1 $2').split(/\s+/))
    // drop very short tokens except known acronyms
    for (const p of parts) {
      if (p.length >= 2) split.push(p)
    }
  }
  return split
}

function hashToken(token: string): number {
  let h = 2166136261
  for (let i = 0; i < token.length; i++) {
    h ^= token.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return Math.abs(h) % EMBED_DIM
}

export function embedText(text: string): number[] {
  const vec = new Array(EMBED_DIM).fill(0)
  const tokens = tokenize(text)
  for (const t of tokens) vec[hashToken(t)] += 1
  // bigrams for shallow phrase structure
  for (let i = 0; i < tokens.length - 1; i++) {
    vec[hashToken(tokens[i] + '_' + tokens[i + 1])] += 0.5
  }
  // L2 normalize
  let norm = 0
  for (const v of vec) norm += v * v
  norm = Math.sqrt(norm) || 1
  return vec.map((v) => v / norm)
}

export function cosine(a: number[], b: number[]): number {
  let dot = 0
  const n = Math.min(a.length, b.length)
  for (let i = 0; i < n; i++) dot += a[i] * b[i]
  return dot
}

// ------------------------------------------------------------
// Document collection
// ------------------------------------------------------------

const DOC_CHUNK = 2000

function chunkText(text: string, size = DOC_CHUNK): string[] {
  if (text.length <= size) return [text]
  const chunks: string[] = []
  let i = 0
  while (i < text.length && chunks.length < 10) {
    chunks.push(text.slice(i, i + size))
    i += size
  }
  return chunks
}

export async function collectSemanticDocuments(
  repoPath: string,
  parsedByFile: Map<string, ParsedFile>,
  commits: CommitInfo[],
  _fileRows: { id: string; path: string }[]
): Promise<SemanticDoc[]> {
  const docs: SemanticDoc[] = []

  const pushDoc = (sourceType: SemanticDoc['sourceType'], sourcePath: string, title: string, content: string) => {
    const trimmed = content.trim()
    if (trimmed.length < 10) return
    const chunks = chunkText(trimmed)
    chunks.forEach((chunk, i) => {
      docs.push({
        sourceType,
        sourcePath,
        title: title.slice(0, 150),
        content: chunk,
        embedding: JSON.stringify(embedText(`${title}\n${chunk}`)),
        chunkIndex: i,
      })
    })
  }

  // markdown docs
  const walk = (dir: string) => {
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch { return }
    for (const e of entries) {
      if (e.name.startsWith('.') || e.name === 'node_modules') continue
      const abs = path.join(dir, e.name)
      const rel = path.relative(repoPath, abs).split(path.sep).join('/')
      if (e.isDirectory()) walk(abs)
      else if (/\.(md|mdx|rst)$/i.test(e.name)) {
        try {
          const content = fs.readFileSync(abs, 'utf8')
          pushDoc(rel.toLowerCase().includes('readme') ? 'readme' : 'doc', rel, e.name, content)
        } catch { /* skip */ }
      }
    }
  }
  walk(repoPath)

  // code file header comments + doc comments as per-file context docs
  for (const [rel, parsed] of parsedByFile) {
    // header comment = doc of first symbol, or first comment block
    const headerDoc = parsed.symbols.find((s) => s.docComment && s.docComment.length > 20)?.docComment
    const interesting = parsed.symbols
      .filter((s) => s.docComment && s.docComment.length > 30)
      .slice(0, 20)
    for (const s of interesting) {
      pushDoc('comment', rel, `${rel} ${s.name} (${s.kind})`, `${s.docComment}\n${s.signature}`)
    }
    if (headerDoc && interesting.length === 0) {
      pushDoc('comment', rel, rel, headerDoc)
    }
  }

  // test descriptions
  for (const [rel, parsed] of parsedByFile) {
    if (!rel.includes('.test.') && !rel.includes('.spec.') && !rel.includes('/test')) continue
    const testNames = parsed.symbols.filter((s) => s.kind === 'function' || s.kind === 'method').map((s) => `${s.name}: ${s.docComment || s.signature}`)
    if (testNames.length) {
      pushDoc('test', rel, rel, `Test file ${rel} covers:\n${testNames.join('\n')}`)
    }
  }

  // commit messages
  for (const c of commits.slice(0, 150)) {
    pushDoc('commit', `git:${c.shortHash}`, c.subject, `${c.subject}\n${c.body || ''}\nfiles: ${c.files.slice(0, 20).join(', ')}`)
  }

  return docs
}

// ------------------------------------------------------------
// Vector search
// ------------------------------------------------------------

export interface VectorHit {
  doc: { sourceType: string; sourcePath: string; title: string; content: string }
  score: number
}

export async function vectorSearch(
  repositoryId: string,
  query: string,
  k = 8
): Promise<VectorHit[]> {
  const { db } = await import('@/lib/db')
  const docs = await db.document.findMany({
    where: { repositoryId },
    select: { sourceType: true, sourcePath: true, title: true, content: true, embedding: true },
  })
  const qv = embedText(query)
  const scored = docs.map((d) => {
    let ev: number[] = []
    try { ev = JSON.parse(d.embedding) } catch { /* ignore */ }
    return {
      doc: { sourceType: d.sourceType, sourcePath: d.sourcePath, title: d.title, content: d.content },
      score: cosine(qv, ev),
    }
  })
  return scored.sort((a, b) => b.score - a.score).slice(0, k).filter((s) => s.score > 0.02)
}
