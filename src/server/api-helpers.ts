// Shared API helpers: auth guard, JSON responses, background jobs.

import { NextResponse } from 'next/server'
import { requireUser, Unauthorized, type SafeUser } from '@/lib/session'
import { db } from '@/lib/db'

export async function withAuth<T>(handler: (user: SafeUser) => Promise<T>): Promise<NextResponse> {
  try {
    const user = await requireUser()
    const result = await handler(user)
    return NextResponse.json(result)
  } catch (err: any) {
    if (err instanceof Unauthorized) {
      return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
    }
    console.error('[api] error:', err)
    return NextResponse.json({ error: err?.message || 'internal error' }, { status: 400 })
  }
}

export function badRequest(message: string): NextResponse {
  return NextResponse.json({ error: message }, { status: 400 })
}

// ------------------------------------------------------------
// Background repository analysis job
// ------------------------------------------------------------

const analysisJobs = new Map<string, { status: string; startedAt: number }>()

export function getAnalysisJobStatus(repoId: string) {
  return analysisJobs.get(repoId) || null
}

/** Kick off (or restart) repository materialization + indexing in the background. */
export function startRepoAnalysis(repoId: string): void {
  if (analysisJobs.has(repoId)) return
  analysisJobs.set(repoId, { status: 'running', startedAt: Date.now() })
  void (async () => {
    try {
      const repo = await db.repository.findUniqueOrThrow({ where: { id: repoId } })
      const { materializeRepository } = await import('./sandbox/workspace')
      const { indexRepository } = await import('./intelligence/indexer')

      await db.repository.update({
        where: { id: repoId },
        data: { cloneStatus: 'cloning', analysisStatus: 'indexing', analysisError: '' },
      })
      // reset analysis row
      await db.repositoryAnalysis.upsert({
        where: { repositoryId: repoId },
        create: { repositoryId: repoId, status: 'running', progress: 0, progressStep: 'starting' },
        update: { status: 'running', progress: 0, progressStep: 'starting', error: '', completedAt: null },
      })

      const materialized = await materializeRepository(repoId, repo.source, repo.sourceType)
      await db.repository.update({
        where: { id: repoId },
        data: { localPath: materialized.path, cloneStatus: 'ready', branch: materialized.branch, defaultBranch: materialized.branch },
      })

      await indexRepository(repoId, materialized.path, (p) => {
        void db.repositoryAnalysis.update({
          where: { repositoryId: repoId },
          data: { progress: p.percent, progressStep: p.step },
        }).catch(() => {})
      })
      await db.repository.update({ where: { id: repoId }, data: { analysisStatus: 'ready' } })
    } catch (err: any) {
      console.error('[jobs] repository analysis failed:', err)
      await db.repository.update({
        where: { id: repoId },
        data: { analysisStatus: 'failed', analysisError: String(err?.message || err).slice(0, 500) },
      }).catch(() => {})
      await db.repositoryAnalysis.update({
        where: { repositoryId: repoId },
        data: { status: 'failed', error: String(err?.message || err).slice(0, 500) },
      }).catch(() => {})
    } finally {
      analysisJobs.delete(repoId)
    }
  })()
}

/** On boot: mark interrupted analyses failed, recover stale agent runs. */
export async function bootstrapRecovery(): Promise<void> {
  try {
    await db.repository.updateMany({
      where: { analysisStatus: 'indexing' },
      data: { analysisStatus: 'failed', analysisError: 'interrupted by server restart — re-run analysis' },
    })
    const { recoverStaleRuns } = await import('./agent/engine')
    await recoverStaleRuns()
  } catch (err) {
    console.warn('[jobs] bootstrap recovery failed:', err)
  }
}
