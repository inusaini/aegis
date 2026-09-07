import { db } from '@/lib/db'
import { withAuth } from '@/server/api-helpers'

/**
 * POST /api/runs/:id/approve
 * Body: { decision: 'approve' | 'reject', reason?: string }
 * The approval gate (spec §13): no high-impact modification happens before this.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  return withAuth(async (user) => {
    const run = await db.agentRun.findFirst({
      where: { id, project: { userId: user.id } },
      include: { plan: true },
    })
    if (!run) throw new Error('run not found')
    if (run.state !== 'WAITING_FOR_APPROVAL') throw new Error(`run is not waiting for approval (state: ${run.state})`)
    if (!run.plan) throw new Error('run has no plan to approve')

    const body = await req.json().catch(() => ({}))
    const decision = body?.decision === 'reject' ? 'reject' : 'approve'
    const reason = String(body?.reason || '').slice(0, 500)

    if (decision === 'approve') {
      await db.plan.update({
        where: { runId: id },
        data: { status: 'approved', approvedBy: user.id, approvedAt: new Date() },
      })
      await db.auditLog.create({
        data: { userId: user.id, action: 'plan.approve', target: id, metadata: JSON.stringify({ objective: run.plan.objective }) },
      })
      // NOTE: the run's own waitForDecision loop picks up the approval within
      // ~1.5s — we deliberately do NOT resumeRun() here to keep a single
      // driver. (If the server restarted while waiting, the instrumentation
      // recovery pass resumes approved runs.)
      return { ok: true, decision: 'approve' }
    } else {
      await db.plan.update({
        where: { runId: id },
        data: { status: 'rejected', rejectionReason: reason },
      })
      await db.agentRun.update({
        where: { id },
        data: { state: 'CANCELLED', finishedAt: new Date() },
      })
      await db.task.update({ where: { id: run.taskId }, data: { status: 'cancelled' } })
      await db.auditLog.create({
        data: { userId: user.id, action: 'plan.reject', target: id, metadata: JSON.stringify({ reason }) },
      })
      return { ok: true, decision: 'reject' }
    }
  })
}

export const dynamic = 'force-dynamic'
