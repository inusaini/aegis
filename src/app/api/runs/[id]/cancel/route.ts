import { db } from '@/lib/db'
import { withAuth } from '@/server/api-helpers'

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  return withAuth(async (user) => {
    const run = await db.agentRun.findFirst({
      where: { id, project: { userId: user.id } },
    })
    if (!run) throw new Error('run not found')
    const { cancelRun } = await import('@/server/agent/engine')
    const cancelled = cancelRun(id)
    if (!cancelled) {
      // not live in this process — mark directly if approval-gated
      if (run.state === 'WAITING_FOR_APPROVAL') {
        await db.agentRun.update({ where: { id }, data: { state: 'CANCELLED', finishedAt: new Date() } })
        await db.task.update({ where: { id: run.taskId }, data: { status: 'cancelled' } })
        return { ok: true, cancelled: 'stale' }
      }
      throw new Error('run is not active')
    }
    return { ok: true, cancelled: 'live' }
  })
}

export const dynamic = 'force-dynamic'
