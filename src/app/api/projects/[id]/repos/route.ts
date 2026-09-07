import { db } from '@/lib/db'
import { withAuth, badRequest, startRepoAnalysis } from '@/server/api-helpers'
import fs from 'fs'
import path from 'path'

/**
 * POST /api/projects/:id/repos
 * Body: { source: string, sourceType: 'remote' | 'local' | 'sample' }
 * Connects a repository to the project and starts background analysis.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  return withAuth(async (user) => {
    const project = await db.project.findFirst({ where: { id, userId: user.id } })
    if (!project) throw new Error('project not found')
    if (project.repository) throw new Error('project already has a repository')

    const body = await req.json().catch(() => ({}))
    const sourceType = String(body?.sourceType || 'sample')
    let source = String(body?.source || '').trim()

    if (sourceType === 'sample') {
      source = 'sample:legacy-shop'
    } else if (sourceType === 'local') {
      if (!source || !path.isAbsolute(source)) throw new Error('local source must be an absolute path')
      if (!fs.existsSync(source)) throw new Error(`path does not exist: ${source}`)
      if (!fs.statSync(source).isDirectory()) throw new Error('source must be a directory')
    } else if (sourceType === 'remote') {
      if (!/^https?:\/\/|git@/.test(source)) throw new Error('remote source must be a git URL (https:// or git@)')
    } else {
      return badRequest('sourceType must be remote, local, or sample')
    }

    const repo = await db.repository.create({
      data: {
        projectId: project.id,
        source,
        sourceType,
        cloneStatus: 'pending',
        analysisStatus: 'pending',
      },
    })
    await db.auditLog.create({ data: { userId: user.id, action: 'repo.connect', target: source, metadata: JSON.stringify({ repositoryId: repo.id, sourceType }) } })

    // kick off materialization + indexing in the background
    startRepoAnalysis(repo.id)

    return { repository: { id: repo.id, source, sourceType, analysisStatus: 'pending' } }
  })
}

export const dynamic = 'force-dynamic'
