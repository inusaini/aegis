import { db } from '@/lib/db'
import { withAuth } from '@/server/api-helpers'

/** GET /api/projects/:id/tasks — list tasks with their latest run. */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  return withAuth(async (user) => {
    const project = await db.project.findFirst({ where: { id, userId: user.id } })
    if (!project) throw new Error('project not found')
    const tasks = await db.task.findMany({
      where: { projectId: id },
      orderBy: { createdAt: 'desc' },
      include: { agentRuns: { orderBy: { startedAt: 'desc' }, take: 3, select: { id: true, state: true, startedAt: true, finishedAt: true } } },
    })
    return {
      tasks: tasks.map((t) => ({
        id: t.id,
        title: t.title,
        description: t.description,
        status: t.status,
        createdAt: t.createdAt.toISOString(),
        runs: t.agentRuns.map((r) => ({
          id: r.id,
          state: r.state,
          startedAt: r.startedAt.toISOString(),
          finishedAt: r.finishedAt?.toISOString() || null,
        })),
      })),
    }
  })
}

/** POST /api/projects/:id/tasks — create a task and immediately start an agent run. */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  return withAuth(async (user) => {
    const project = await db.project.findFirst({
      where: { id, userId: user.id },
      include: { repository: true },
    })
    if (!project) throw new Error('project not found')
    if (!project.repository) throw new Error('connect a repository before creating tasks')
    if (project.repository.analysisStatus !== 'ready') throw new Error('repository analysis is not ready yet')

    const body = await req.json().catch(() => ({}))
    const description = String(body?.description || '').trim()
    if (description.length < 10) throw new Error('task description must be at least 10 characters')

    const title = description.length > 70 ? description.slice(0, 70) + '…' : description
    const task = await db.task.create({
      data: { projectId: id, userId: user.id, title, description },
    })
    await db.auditLog.create({ data: { userId: user.id, action: 'task.create', target: task.id, metadata: JSON.stringify({ projectId: id }) } })

    // start the agent run in the background
    const { startRun } = await import('@/server/agent/engine')
    const runId = await startRun(task.id)

    return {
      task: { id: task.id, title: task.title, description: task.description, status: task.status },
      runId,
    }
  })
}

export const dynamic = 'force-dynamic'
