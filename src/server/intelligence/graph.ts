// ============================================================
// Dependency / relationship graph (spec §5.2).
// Queryable by the agent: find_symbol, find_references,
// get_callers, get_callees, get_dependencies, get_tests,
// plus impact traversal and system-map export.
// ============================================================

import { db } from '@/lib/db'

export interface GraphSymbol {
  id: string
  fileId: string
  file: string
  name: string
  qualifiedName: string
  kind: string
  lineStart: number
  lineEnd: number
  signature: string
  exported: boolean
  docComment: string
}

export interface GraphFile {
  id: string
  path: string
  language: string
  loc: number
  isTest: boolean
  isConfig: boolean
  isDoc: boolean
  module: string
}

export interface GraphEdge {
  kind: string
  fromFile: string
  fromSymbol: string
  toFile: string
  toSymbol: string
}

export class RepoGraph {
  files = new Map<string, GraphFile>() // path -> file
  symbols = new Map<string, GraphSymbol>() // qualifiedName -> symbol
  symbolsByName = new Map<string, GraphSymbol[]>()
  symbolsByFile = new Map<string, GraphSymbol[]>()
  edges: GraphEdge[] = []

  importsOf = new Map<string, Set<string>>() // file -> imported files
  importersOf = new Map<string, Set<string>>() // file -> files importing it
  testersOf = new Map<string, Set<string>>() // file -> test files
  dbAccess = new Map<string, { file: string; access: string }[]>() // db:<table> -> accessors
  externalDeps = new Map<string, Set<string>>() // file -> external packages
  callersOf = new Map<string, Set<{ file: string; fromSymbol: string }>>() // qualifiedName -> callers
  calleesOf = new Map<string, Set<string>>() // qualifiedName -> callee qualifiedNames

  static async load(repositoryId: string): Promise<RepoGraph> {
    const g = new RepoGraph()
    const [files, symbols, rels] = await Promise.all([
      db.file.findMany({ where: { repositoryId } }),
      db.symbol.findMany({ where: { repositoryId }, include: { file: true } }),
      db.relationship.findMany({ where: { repositoryId } }),
    ])

    const fileIdToPath = new Map<string, string>()
    for (const f of files) {
      const rec: GraphFile = {
        id: f.id, path: f.path, language: f.language, loc: f.loc,
        isTest: f.isTest, isConfig: f.isConfig, isDoc: f.isDoc, module: f.module,
      }
      g.files.set(f.path, rec)
      fileIdToPath.set(f.id, f.path)
    }

    for (const s of symbols) {
      const file = fileIdToPath.get(s.fileId) || ''
      const rec: GraphSymbol = {
        id: s.id, fileId: s.fileId, file, name: s.name, qualifiedName: s.qualifiedName,
        kind: s.kind, lineStart: s.lineStart, lineEnd: s.lineEnd,
        signature: s.signature, exported: s.exported, docComment: s.docComment,
      }
      g.symbols.set(s.qualifiedName, rec)
      const byName = g.symbolsByName.get(s.name) || []
      byName.push(rec)
      g.symbolsByName.set(s.name, byName)
      const byFile = g.symbolsByFile.get(file) || []
      byFile.push(rec)
      g.symbolsByFile.set(file, byFile)
    }

    for (const r of rels) {
      const edge: GraphEdge = { kind: r.kind, fromFile: r.fromFile, fromSymbol: r.fromSymbol, toFile: r.toFile, toSymbol: r.toSymbol }
      g.edges.push(edge)
      switch (r.kind) {
        case 'IMPORTS': {
          const s = g.importsOf.get(r.fromFile) || new Set<string>()
          s.add(r.toFile)
          g.importsOf.set(r.fromFile, s)
          const t = g.importersOf.get(r.toFile) || new Set<string>()
          t.add(r.fromFile)
          g.importersOf.set(r.toFile, t)
          break
        }
        case 'TESTS': {
          const t = g.testersOf.get(r.toFile) || new Set<string>()
          t.add(r.fromFile)
          g.testersOf.set(r.toFile, t)
          break
        }
        case 'READS':
        case 'WRITES': {
          const list = g.dbAccess.get(r.toFile) || []
          list.push({ file: r.fromFile, access: r.kind })
          g.dbAccess.set(r.toFile, list)
          break
        }
        case 'DEPENDS_ON': {
          const s = g.externalDeps.get(r.fromFile) || new Set<string>()
          s.add(r.toFile.replace('external:', ''))
          g.externalDeps.set(r.fromFile, s)
          break
        }
        case 'CALLS': {
          if (r.toSymbol) {
            const callers = g.callersOf.get(r.toSymbol) || new Set<{ file: string; fromSymbol: string }>()
            callers.add({ file: r.fromFile, fromSymbol: r.fromSymbol })
            g.callersOf.set(r.toSymbol, callers)
            if (r.fromSymbol) {
              const callees = g.calleesOf.get(r.fromSymbol) || new Set<string>()
              callees.add(r.toSymbol)
              g.calleesOf.set(r.fromSymbol, callees)
            }
          }
          break
        }
        default:
          break
      }
    }
    return g
  }

  // ---------- query API (agent tools) ----------

  findSymbol(name: string): GraphSymbol[] {
    const exact = this.symbolsByName.get(name)
    if (exact?.length) return exact
    // fuzzy: contains
    const hits: GraphSymbol[] = []
    for (const [n, syms] of this.symbolsByName) {
      if (n.toLowerCase().includes(name.toLowerCase())) hits.push(...syms)
    }
    return hits.slice(0, 30)
  }

  findReferences(qualifiedName: string): { file: string; kind: string; fromSymbol: string }[] {
    return this.edges
      .filter((e) => e.toSymbol === qualifiedName || (e.toFile === qualifiedName))
      .map((e) => ({ file: e.fromFile, kind: e.kind, fromSymbol: e.fromSymbol }))
  }

  getCallers(qualifiedName: string): { file: string; fromSymbol: string }[] {
    return [...(this.callersOf.get(qualifiedName) || [])]
  }

  getCallees(qualifiedName: string): string[] {
    return [...(this.calleesOf.get(qualifiedName) || [])]
  }

  getDependencies(file: string): { local: string[]; external: string[] } {
    return {
      local: [...(this.importsOf.get(file) || [])],
      external: [...(this.externalDeps.get(file) || [])],
    }
  }

  getImporters(file: string): string[] {
    return [...(this.importersOf.get(file) || [])]
  }

  getTests(file: string): string[] {
    const direct = this.testersOf.get(file) || new Set<string>()
    // tests of importers count as related coverage
    return [...direct]
  }

  getRelatedTests(file: string): string[] {
    const out = new Set<string>(this.getTests(file))
    for (const imp of this.importersOf.get(file) || new Set<string>()) {
      for (const t of this.testersOf.get(imp) || new Set<string>()) out.add(t)
    }
    return [...out]
  }

  getFileSymbols(file: string): GraphSymbol[] {
    return this.symbolsByFile.get(file) || []
  }

  // ---------- impact traversal ----------

  /** Files that depend on the given files (direct + transitive over IMPORTS/CALLS). */
  impactClosure(seedFiles: string[], maxDepth = 6): { direct: Set<string>; indirect: Set<string>; depth: Map<string, number> } {
    const direct = new Set<string>()
    const indirect = new Set<string>()
    const depth = new Map<string, number>()
    const visited = new Set<string>(seedFiles)

    const queue: { file: string; d: number }[] = seedFiles.map((f) => ({ file: f, d: 0 }))
    while (queue.length) {
      const { file, d } = queue.shift()!
      if (d >= maxDepth) continue
      const dependents = new Set<string>(this.importersOf.get(file) || [])
      // also files whose CALLS edges point into symbols of this file
      for (const e of this.edges) {
        if (e.toFile === file && e.kind === 'CALLS' && e.fromFile !== file) dependents.add(e.fromFile)
        if (e.kind === 'TESTS' && e.toFile === file) dependents.add(e.fromFile)
      }
      for (const dep of dependents) {
        if (visited.has(dep)) continue
        visited.add(dep)
        depth.set(dep, d + 1)
        if (d === 0) direct.add(dep)
        else indirect.add(dep)
        queue.push({ file: dep, d: d + 1 })
      }
    }
    return { direct, indirect, depth }
  }

  // ---------- system map ----------

  systemMap(): { nodes: { id: string; label: string; layer: string; meta: { files: number; symbols: number } }[]; edges: { source: string; target: string; kind: string; count: number }[] } {
    const nodes: { id: string; label: string; layer: string; meta: { files: number; symbols: number } }[] = []
    const edgeAgg = new Map<string, { source: string; target: string; kind: string; count: number }>()

    const layerFor = (p: string): string => {
      const lower = p.toLowerCase()
      if (lower.startsWith('db:')) return 'data'
      if (lower.startsWith('external:')) return 'external'
      if (/\/(routes?|controllers?|api|handlers?)\//.test(lower) || /route/.test(lower)) return 'api'
      if (/\/(services?|domains?|usecases?|business)\//.test(lower)) return 'service'
      if (/\/(entries|entries|apps?)\//.test(lower) || /^(app|main|index|server)\./.test(lower)) return 'entry'
      if (/\/(config|configs|settings)\//.test(lower) || /config/.test(lower)) return 'config'
      if (/\/(repos?|repositories|db|database|models?|daos?|store)\//.test(lower)) return 'data'
      if (lower.includes('.test.') || lower.includes('/tests/')) return 'tests'
      return 'service'
    }

    const groupFor = (p: string): { id: string; label: string } => {
      if (p.startsWith('db:')) return { id: p, label: p.replace('db:', '') }
      if (p.startsWith('external:')) return { id: p, label: p.replace('external:', '') }
      const dir = p.split('/').slice(0, -1).join('/')
      if (!dir || dir === '.') {
        const base = p.split('/').pop() || p
        return { id: `root:${base}`, label: base }
      }
      // group by directory
      const parts = dir.split('/')
      const label = parts[parts.length - 1]
      const clean = parts.filter((x) => !['src', 'app', 'lib'].includes(x))
      return { id: `dir:${clean.join('/') || label}`, label }
    }

    const nodeAgg = new Map<string, { label: string; layer: string; files: Set<string>; symbols: number }>()
    const fileToNode = new Map<string, string>()

    for (const f of this.files.values()) {
      if (f.isTest) continue
      const { id, label } = groupFor(f.path)
      const rec = nodeAgg.get(id) || { label, layer: layerFor(f.path), files: new Set<string>(), symbols: 0 }
      rec.files.add(f.path)
      rec.symbols += this.symbolsByFile.get(f.path)?.length || 0
      nodeAgg.set(id, rec)
      fileToNode.set(f.path, id)
    }
    for (const [id, rec] of nodeAgg) {
      nodes.push({ id, label: rec.label, layer: rec.layer, meta: { files: rec.files.size, symbols: rec.symbols } })
    }

    for (const e of this.edges) {
      if (e.kind === 'CALLS') {
        const source = fileToNode.get(e.fromFile)
        const target = e.toFile.startsWith('db:') || e.toFile.startsWith('external:') ? e.toFile : fileToNode.get(e.toFile)
        if (source && target && source !== target) {
          const key = `${source}->${target}:CALLS`
          const rec = edgeAgg.get(key) || { source, target, kind: 'calls', count: 0 }
          rec.count++
          edgeAgg.set(key, rec)
        }
      } else if (e.kind === 'IMPORTS' || e.kind === 'DEPENDS_ON') {
        const source = fileToNode.get(e.fromFile)
        const target = e.toFile.startsWith('external:') ? e.toFile : fileToNode.get(e.toFile)
        if (source && target && source !== target) {
          const kind = e.kind === 'DEPENDS_ON' ? 'uses' : 'imports'
          const key = `${source}->${target}:${kind}`
          const rec = edgeAgg.get(key) || { source, target, kind, count: 0 }
          rec.count++
          edgeAgg.set(key, rec)
        }
      } else if (e.kind === 'READS' || e.kind === 'WRITES') {
        const source = fileToNode.get(e.fromFile)
        if (source && e.toFile.startsWith('db:')) {
          const key = `${source}->${e.toFile}:data`
          const rec = edgeAgg.get(key) || { source, target: e.toFile, kind: 'data', count: 0 }
          rec.count++
          edgeAgg.set(key, rec)
          if (!nodeAgg.has(e.toFile)) {
            nodeAgg.set(e.toFile, { label: e.toFile.replace('db:', ''), layer: 'data', files: new Set(), symbols: 0 })
            nodes.push({ id: e.toFile, label: e.toFile.replace('db:', ''), layer: 'data', meta: { files: 0, symbols: 0 } })
          }
        }
      }
    }

    return { nodes, edges: [...edgeAgg.values()] }
  }
}
