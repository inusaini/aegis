import { db } from '@/lib/db'
import { withAuth } from '@/server/api-helpers'

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  return withAuth(async (user) => {
    const repo = await db.repository.findFirst({
      where: { id, project: { userId: user.id } },
    })
    if (!repo) throw new Error('repository not found')
    const { RepoGraph } = await import('@/server/intelligence/graph')
    const graph = await RepoGraph.load(repo.id)
    const map = graph.systemMap()
    return {
      nodes: map.nodes,
      edges: map.edges,
      layers: [
        { id: 'entry', label: 'Entry points' },
        { id: 'api', label: 'API / routes' },
        { id: 'service', label: 'Services' },
        { id: 'config', label: 'Config' },
        { id: 'data', label: 'Data' },
        { id: 'external', label: 'External' },
      ],
    }
  })
}

export const dynamic = 'force-dynamic'
