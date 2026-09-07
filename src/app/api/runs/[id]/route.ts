import { db } from '@/lib/db'
import { withAuth } from '@/server/api-helpers'
import type { AgentState, ChangeView, PlanView, RunView, TestRunView, ImpactView } from '@/lib/types'

/** GET /api/runs/:id — full run detail: state, plan, impact, changes, tests, result. */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  return withAuth(async (user) => {
    const run = await db.agentRun.findFirst({
      where: { id, project: { userId: user.id } },
      include: {
        task: true,
        plan: true,
        changes: true,
        testRuns: { orderBy: { startedAt: 'asc' } },
      },
    })
    if (!run) throw new Error('run not found')

    let stateData: any = {}
    try { stateData = JSON.parse(run.stateData) } catch { /* ignore */ }

    const plan: PlanView | null = run.plan
      ? {
          id: run.plan.id,
          status: run.plan.status as PlanView['status'],
          objective: run.plan.objective,
          assumptions: JSON.parse(run.plan.assumptions || '[]'),
          filesToModify: JSON.parse(run.plan.filesToModify || '[]'),
          filesToCreate: JSON.parse(run.plan.filesToCreate || '[]'),
          filesToDelete: JSON.parse(run.plan.filesToDelete || '[]'),
          databaseChanges: JSON.parse(run.plan.databaseChanges || '[]'),
          apiChanges: JSON.parse(run.plan.apiChanges || '[]'),
          dependencies: JSON.parse(run.plan.dependencies || '[]'),
          testsRequired: JSON.parse(run.plan.testsRequired || '[]'),
          risks: JSON.parse(run.plan.risks || '[]'),
          rollbackStrategy: run.plan.rollbackStrategy,
          ...(() => {
            try {
              const full = JSON.parse(run.plan!.full || '{}')
              return { narrative: full.narrative || undefined, steps: full.steps || undefined }
            } catch { return {} }
          })(),
          approvedAt: run.plan.approvedAt?.toISOString() || null,
          rejectionReason: run.plan.rejectionReason,
        }
      : null

    const impact: ImpactView | null = stateData.impact_analysis
      ? {
          riskLevel: stateData.impact_analysis.riskLevel || 'LOW',
          filesAffected: (stateData.impact_analysis.filesAffected || []) as ImpactView['filesAffected'],
          servicesAffected: stateData.impact_analysis.servicesAffected || [],
          apisAffected: stateData.impact_analysis.apisAffected || [],
          databaseChanges: stateData.impact_analysis.databaseChanges || [],
          testsAffected: stateData.impact_analysis.testsAffected || [],
          compatibilityConcerns: stateData.impact_analysis.compatibilityConcerns ?? [],
          evidence: stateData.impact_analysis.evidence || [],
          blastRadius: stateData.impact_analysis.blastRadius || { direct: 0, indirect: 0 },
        }
      : null

    const changes: ChangeView[] = run.changes.map((c) => ({
      file: c.file,
      changeType: c.changeType as ChangeView['changeType'],
      additions: c.additions,
      deletions: c.deletions,
      diff: c.diff,
    }))

    const testRuns: TestRunView[] = run.testRuns.map((t) => ({
      id: t.id,
      kind: t.kind,
      command: t.command,
      status: t.status,
      summary: t.summary,
      durationMs: t.durationMs,
      fixAttempt: t.fixAttempt,
      classification: t.classification,
      output: t.output.slice(0, 8000),
    }))

    const runView: RunView = {
      id: run.id,
      taskId: run.taskId,
      state: run.state as AgentState,
      branch: run.branch,
      provider: run.provider,
      model: run.model,
      startedAt: run.startedAt.toISOString(),
      finishedAt: run.finishedAt?.toISOString() || null,
      error: run.error,
      task: { id: run.task.id, title: run.task.title, description: run.task.description, status: run.task.status },
      plan,
      impact,
      changes,
      testRuns,
      finalResult: stateData.final_result || null,
      tokenUsage: run.tokenUsage,
    }
    return { run: runView, stateData: { relevantComponents: stateData.relevant_components || null, understanding: stateData.repository_understanding || null, historicalContext: stateData.historical_context || [] } }
  })
}

export const dynamic = 'force-dynamic'
