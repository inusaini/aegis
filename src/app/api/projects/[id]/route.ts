import { db } from '@/lib/db'
import { withAuth } from '@/server/api-helpers'
import { NextResponse } from 'next/server'

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  return withAuth(async (user) => {
    const project = await db.project.findFirst({
      where: { id, userId: user.id },
      include: {
        repository: { include: { analysis: true } },
        tasks: {
          orderBy: { createdAt: 'desc' },
          take: 30,
          include: { agentRuns: { orderBy: { startedAt: 'desc' }, take: 1, select: { id: true, state: true, startedAt: true, finishedAt: true } } },
        },
        memories: { orderBy: { createdAt: 'desc' }, take: 30 },
      },
    })
    if (!project) throw new Error('project not found')
    return {
      project: {
        id: project.id,
        name: project.name,
        description: project.description,
        createdAt: project.createdAt.toISOString(),
        repository: project.repository
          ? {
              id: project.repository.id,
              source: project.repository.source,
              sourceType: project.repository.sourceType,
              branch: project.repository.branch,
              analysisStatus: project.repository.analysisStatus,
              analysisError: project.repository.analysisError,
              lastIndexedAt: project.repository.lastIndexedAt?.toISOString() || null,
              fileCount: project.repository.fileCount,
              defaultBranch: project.repository.defaultBranch,
              progress: project.repository.analysis?.progress ?? 0,
              progressStep: project.repository.analysis?.progressStep ?? '',
            }
          : null,
        tasks: project.tasks.map((t) => ({
          id: t.id,
          title: t.title,
          description: t.description,
          status: t.status,
          createdAt: t.createdAt.toISOString(),
          latestRun: t.agentRuns[0]
            ? {
                id: t.agentRuns[0].id,
                state: t.agentRuns[0].state,
                startedAt: t.agentRuns[0].startedAt.toISOString(),
                finishedAt: t.agentRuns[0].finishedAt?.toISOString() || null,
              }
            : null,
          runs: t.agentRuns.map((r) => ({
            id: r.id,
            state: r.state,
            startedAt: r.startedAt.toISOString(),
            finishedAt: r.finishedAt?.toISOString() || null,
          })),
        })),
        memories: project.memories.map((m) => ({
          id: m.id,
          kind: m.kind,
          category: m.category,
          content: m.content,
          source: m.source,
          confidence: m.confidence,
          createdAt: m.createdAt.toISOString(),
        })),
      },
    }
  })
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  return withAuth(async (user) => {
    const project = await db.project.findFirst({ where: { id, userId: user.id } })
    if (!project) throw new Error('project not found')
    await db.project.delete({ where: { id } })
    await db.auditLog.create({ data: { userId: user.id, action: 'project.delete', target: id } })
    return { ok: true }
  })
}

export const dynamic = 'force-dynamic'
