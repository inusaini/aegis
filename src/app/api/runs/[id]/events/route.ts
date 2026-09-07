import { db } from '@/lib/db'
import { withAuth } from '@/server/api-helpers'

/** GET /api/runs/:id/events?after=<seq> — polling endpoint for live activity. */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  return withAuth(async (user) => {
    const run = await db.agentRun.findFirst({
      where: { id, project: { userId: user.id } },
      select: { id: true, state: true },
    })
    if (!run) throw new Error('run not found')
    const after = parseInt(new URL(req.url).searchParams.get('after') || '0', 10) || 0
    const events = await db.agentEvent.findMany({
      where: { runId: id, seq: { gt: after } },
      orderBy: { seq: 'asc' },
      take: 200,
    })
    return {
      state: run.state,
      events: events.map((e) => ({
        id: e.id,
        seq: e.seq,
        phase: e.phase,
        type: e.type,
        title: e.title,
        detail: e.detail,
        data: JSON.parse(e.data || '{}'),
        createdAt: e.createdAt.toISOString(),
      })),
    }
  })
}

export const dynamic = 'force-dynamic'
