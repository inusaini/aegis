import { db } from '@/lib/db'
import { withAuth } from '@/server/api-helpers'

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  return withAuth(async (user) => {
    const repo = await db.repository.findFirst({
      where: { id, project: { userId: user.id } },
    })
    if (!repo) throw new Error('repository not found')
    const { startRepoAnalysis } = await import('@/server/api-helpers')
    startRepoAnalysis(repo.id)
    return { ok: true, status: 'indexing' }
  })
}

export const dynamic = 'force-dynamic'
