import { db } from '@/lib/db'
import { withAuth } from '@/server/api-helpers'

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  return withAuth(async (user) => {
    const task = await db.task.findFirst({
      where: { id, userId: user.id },
      include: {
        agentRuns: { orderBy: { startedAt: 'desc' }, take: 5, select: { id: true, state: true, startedAt: true, finishedAt: true, branch: true } },
      },
    })
    if (!task) throw new Error('task not found')
    return {
      task: {
        id: task.id,
        title: task.title,
        description: task.description,
        status: task.status,
        createdAt: task.createdAt.toISOString(),
        runs: task.agentRuns.map((r) => ({
          id: r.id,
          state: r.state,
          branch: r.branch,
          startedAt: r.startedAt.toISOString(),
          finishedAt: r.finishedAt?.toISOString() || null,
        })),
      },
    }
  })
}

export const dynamic = 'force-dynamic'
