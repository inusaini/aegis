// ============================================================
// Impact analysis (spec §14): blast radius of a proposed change
// — direct/indirect references, callers, APIs, DB, tests,
// config, external deps — with an evidence-backed risk level.
// ============================================================

import { db } from '@/lib/db'
import { RepoGraph } from './graph'
import type { RetrievalResult } from './retrieval'
import fs from 'fs'
import path from 'path'

export interface ImpactAnalysisResult {
  riskLevel: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL'
  riskRationale: string
  filesAffected: { path: string; reason: string }[]
  servicesAffected: string[]
  apisAffected: string[]
  databaseChanges: string[]
  testsAffected: { path: string; reason: string }[]
  compatibilityConcerns: string[]
  evidence: { source: string; detail: string }[]
  blastRadius: { direct: number; indirect: number }
}

const LEGACY_MARKERS = /DO NOT|HACK|FIXME|XXX|legacy|workaround|deprecated|race condition|known issue|compatib/i

export async function analyzeImpact(
  repositoryId: string,
  repoPath: string,
  task: string,
  retrieval: RetrievalResult,
  opts: { graph?: RepoGraph; plannedFiles?: string[] } = {}
): Promise<ImpactAnalysisResult> {
  const graph = opts.graph ?? await RepoGraph.load(repositoryId)
  const seedFiles = opts.plannedFiles?.length
    ? opts.plannedFiles
    : retrieval.relevantFiles.slice(0, 8)

  // ---- blast radius over the reverse dependency graph ----
  const { direct, indirect } = graph.impactClosure(seedFiles)
  const evidence: ImpactAnalysisResult['evidence'] = []
  const compatibilityConcerns: string[] = []
  const databaseChanges: string[] = []
  const apisAffected: string[] = []
  const testsAffected: ImpactAnalysisResult['testsAffected'] = []
  const servicesAffected = new Set<string>()

  const allAffected = [...seedFiles, ...direct, ...indirect]

  // ---- per-file attribution ----
  const filesAffected: ImpactAnalysisResult['filesAffected'] = []
  for (const f of seedFiles) {
    const reasons: string[] = ['relevant to the task (retrieval)']
    const syms = graph.getFileSymbols(f)
    const legacySyms = syms.filter((s) => LEGACY_MARKERS.test(s.docComment))
    if (legacySyms.length) {
      reasons.push(`contains legacy markers: ${legacySyms.map((s) => s.name).slice(0, 3).join(', ')}`)
      compatibilityConcerns.push(`${f}: legacy documentation on ${legacySyms.map((s) => s.name).slice(0, 2).join(', ')} — read the comments and git history before changing`)
    }
    filesAffected.push({ path: f, reason: reasons.join('; ') })
    const dirPath = f.split('/').slice(0, -1).join('/')
    if (/service|domain/i.test(dirPath)) servicesAffected.add(dirPath || f)
  }
  for (const f of direct) {
    filesAffected.push({ path: f, reason: 'directly depends on affected code' })
    if (/route|controller|api/i.test(f)) apisAffected.push(f)
  }
  for (const f of indirect) {
    filesAffected.push({ path: f, reason: 'transitively affected' })
    if (/route|controller|api/i.test(f)) apisAffected.push(f)
  }

  // ---- database channel ----
  for (const [table, accessors] of graph.dbAccess) {
    const relevant = accessors.filter((a) => allAffected.includes(a.file))
    if (relevant.length) {
      const reads = relevant.filter((a) => a.access === 'READS').length
      const writes = relevant.filter((a) => a.access === 'WRITES').length
      databaseChanges.push(
        `${table.replace('db:', '')}: ${reads} reader(s), ${writes} writer(s) among affected files — schema or access-pattern changes here propagate to ${reads + writes} call sites`
      )
    }
  }

  // ---- API channel (routes) ----
  const routeSymbols = await db.symbol.findMany({
    where: { repositoryId, kind: 'route' },
    select: { name: true, file: { select: { path: true } } },
  })
  for (const r of routeSymbols) {
    if (allAffected.includes(r.file.path) && !apisAffected.includes(r.name)) {
      apisAffected.push(r.name)
    }
  }
  // legacy-shop-style hand-rolled routers: routes/ files are the API surface
  for (const f of allAffected) {
    if (/\/routes?\//.test(f) && !apisAffected.some((a) => a.includes(f))) {
      apisAffected.push(`route module ${f}`)
    }
  }

  // ---- tests channel ----
  for (const f of seedFiles) {
    for (const t of graph.getRelatedTests(f)) {
      testsAffected.push({ path: t, reason: `covers ${f}` })
    }
  }
  for (const f of [...direct, ...indirect]) {
    for (const t of graph.getTests(f)) {
      if (!testsAffected.some((x) => x.path === t)) testsAffected.push({ path: t, reason: `covers ${f}` })
    }
  }

  // ---- external deps + config ----
  for (const f of allAffected) {
    const externals = graph.getDependencies(f).external
    for (const ext of externals) {
      evidence.push({ source: 'dependency', detail: `${f} uses external package ${ext}` })
    }
  }

  // ---- git evidence: recent churn + legacy commits near the seeds ----
  const { getLog, blameFile } = await import('./git')
  for (const f of seedFiles.slice(0, 4)) {
    const log = getLog(repoPath, { file: f, limit: 5 })
    if (log.length >= 3) {
      evidence.push({ source: 'git', detail: `${f} has ${log.length}+ recent commits (${log[0].subject})` })
    }
    const legacyCommit = log.find((c) => LEGACY_MARKERS.test(c.subject) || /HACK|workaround/i.test(c.subject))
    if (legacyCommit) {
      evidence.push({ source: 'git', detail: `${f}: commit ${legacyCommit.shortHash} "${legacyCommit.subject}" — historical compatibility constraint` })
      compatibilityConcerns.push(`${f} carries a git-documented workaround (${legacyCommit.shortHash}). Preserve it unless the task explicitly requires changing it.`)
    }
  }

  // ---- risk scoring ----
  let score = 0
  score += Math.min(direct.size * 2, 20)
  score += Math.min(indirect.size, 12)
  score += databaseChanges.length * 4
  score += apisAffected.length * 2
  score += compatibilityConcerns.length * 5
  const moneyOrAuth = /payment|charge|refund|auth|login|password|token|user|customer|money|price|billing/i.test(task)
  if (moneyOrAuth) score += 8
  const idContract = /\b(uuid|integer\s*id|ids?\b)/i.test(task) && /change|convert|switch|migrate/i.test(task)
  if (idContract) score += 10
  const wideRefactor = /refactor|rewrite|migrate|replace|remove/i.test(task)
  if (wideRefactor) score += 4

  let riskLevel: ImpactAnalysisResult['riskLevel'] = 'LOW'
  if (score >= 45) riskLevel = 'CRITICAL'
  else if (score >= 25) riskLevel = 'HIGH'
  else if (score >= 10) riskLevel = 'MEDIUM'

  const riskRationale = [
    `${direct.size} direct dependent file(s), ${indirect.size} transitive`,
    `${databaseChanges.length} database touchpoint(s)`,
    `${apisAffected.length} API surface element(s)`,
    `${testsAffected.length} test file(s) in the blast radius`,
    `${compatibilityConcerns.length} compatibility concern(s) from legacy markers and git history`,
    moneyOrAuth ? 'task touches payment/auth-sensitive domain' : '',
  ].filter(Boolean).join('; ')

  return {
    riskLevel,
    riskRationale,
    filesAffected: filesAffected.slice(0, 30),
    servicesAffected: [...servicesAffected].slice(0, 12),
    apisAffected: [...new Set(apisAffected)].slice(0, 12),
    databaseChanges,
    testsAffected: dedupe(testsAffected).slice(0, 20),
    compatibilityConcerns: [...new Set(compatibilityConcerns)].slice(0, 10),
    evidence: evidence.slice(0, 20),
    blastRadius: { direct: direct.size, indirect: indirect.size },
  }
}

function dedupe(arr: { path: string; reason: string }[]): { path: string; reason: string }[] {
  const seen = new Set<string>()
  return arr.filter((a) => {
    if (seen.has(a.path)) return false
    seen.add(a.path)
    return true
  })
}
