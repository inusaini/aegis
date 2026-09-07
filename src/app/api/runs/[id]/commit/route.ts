import { db } from '@/lib/db'
import { withAuth } from '@/server/api-helpers'

/**
 * POST /api/runs/:id/commit — create a git commit of the agent's changes
 * on the run's isolated branch. Explicit user action (spec §7, §23:
 * no automatic production deployment / merging).
 * Body: { message?: string }
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  return withAuth(async (user) => {
    const run = await db.agentRun.findFirst({
      where: { id, project: { userId: user.id } },
    })
    if (!run) throw new Error('run not found')
    if (!run.workspacePath) throw new Error('run has no workspace')
    if (run.state !== 'COMPLETED') throw new Error(`run is not completed (state: ${run.state})`)

    const body = await req.json().catch(() => ({}))
    const defaultMsg = `agent: ${run.taskId} — see run ${id}`
    const message = String(body?.message || '').trim() || defaultMsg

    const { commitWorkspace } = await import('@/server/sandbox/workspace')
    const result = await commitWorkspace(run.workspacePath, message)

    await db.auditLog.create({
      data: { userId: user.id, action: 'run.commit', target: id, metadata: JSON.stringify({ hash: result.hash, message }) },
    })

    // record in the event log
    const { RunEventLog } = await import('@/server/agent/events')
    const events = new RunEventLog(id)
    await events.emit('review', 'success', result.committed ? `Changes committed on branch ${run.branch}` : 'Nothing to commit',
      result.committed ? `commit ${result.hash}: ${message}` : 'working tree already clean')

    return {
      committed: result.committed,
      hash: result.hash,
      branch: run.branch,
      message,
    }
  })
}

export const dynamic = 'force-dynamic'
