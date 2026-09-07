import { db } from '@/lib/db'
import { withAuth } from '@/server/api-helpers'

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  return withAuth(async (user) => {
    const repo = await db.repository.findFirst({
      where: { id, project: { userId: user.id } },
      include: { analysis: true },
    })
    if (!repo) throw new Error('repository not found')
    if (!repo.analysis || repo.analysis.status !== 'completed') {
      return {
        overview: null,
        status: repo.analysisStatus,
        progress: repo.analysis?.progress ?? 0,
        progressStep: repo.analysis?.progressStep ?? '',
        error: repo.analysisError,
      }
    }
    return {
      overview: JSON.parse(repo.analysis.overview || '{}'),
      status: repo.analysisStatus,
      repository: {
        source: repo.source,
        branch: repo.branch,
        defaultBranch: repo.defaultBranch,
        fileCount: repo.fileCount,
        sizeKb: repo.sizeKb,
        lastIndexedAt: repo.lastIndexedAt?.toISOString(),
        headCommit: repo.headCommit,
      },
    }
  })
}

export const dynamic = 'force-dynamic'
