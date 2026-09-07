import { db } from '@/lib/db'
import { withAuth } from '@/server/api-helpers'

/** GET /api/repos/:id/search?q=... — symbol + file search over the index. */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  return withAuth(async (user) => {
    const repo = await db.repository.findFirst({
      where: { id, project: { userId: user.id } },
    })
    if (!repo) throw new Error('repository not found')
    const q = new URL(req.url).searchParams.get('q')?.trim() || ''
    if (q.length < 2) return { results: [] }

    const { RepoGraph } = await import('@/server/intelligence/graph')
    const graph = await RepoGraph.load(repo.id)
    const symbols = graph.findSymbol(q).slice(0, 15).map((s) => ({
      type: 'symbol' as const,
      label: `${s.kind} ${s.name}`,
      path: s.file,
      line: s.lineStart,
      signature: s.signature,
    }))
    const files = [...graph.files.keys()]
      .filter((p) => p.toLowerCase().includes(q.toLowerCase()))
      .slice(0, 15)
      .map((p) => ({ type: 'file' as const, label: p, path: p, line: 0, signature: '' }))
    return { results: [...symbols, ...files].slice(0, 25) }
  })
}

export const dynamic = 'force-dynamic'
