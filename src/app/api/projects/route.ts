import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { withAuth, badRequest } from '@/server/api-helpers'
import type { ProjectSummary } from '@/lib/types'

export async function GET() {
  return withAuth(async (user) => {
    const projects = await db.project.findMany({
      where: { userId: user.id },
      orderBy: { createdAt: 'desc' },
      include: {
        repository: true,
        tasks: {
          orderBy: { createdAt: 'desc' },
          take: 5,
          include: { agentRuns: { orderBy: { startedAt: 'desc' }, take: 1, select: { id: true, state: true, startedAt: true, finishedAt: true } } },
        },
      },
    })
    const summaries: ProjectSummary[] = projects.map((p) => ({
      id: p.id,
      name: p.name,
      description: p.description,
      createdAt: p.createdAt.toISOString(),
      repository: p.repository
        ? {
            id: p.repository.id,
            source: p.repository.source,
            sourceType: p.repository.sourceType,
            branch: p.repository.branch,
            analysisStatus: p.repository.analysisStatus,
            lastIndexedAt: p.repository.lastIndexedAt?.toISOString() || null,
            fileCount: p.repository.fileCount,
            defaultBranch: p.repository.defaultBranch,
          }
        : null,
      recentTasks: p.tasks.map((t) => ({
        id: t.id,
        title: t.title,
        status: t.status,
        createdAt: t.createdAt.toISOString(),
        latestRun: t.agentRuns[0]
          ? {
              id: t.agentRuns[0].id,
              state: t.agentRuns[0].state as ProjectSummary['recentTasks'][number]['latestRun'] extends null ? never : string,
              startedAt: t.agentRuns[0].startedAt.toISOString(),
              finishedAt: t.agentRuns[0].finishedAt?.toISOString() || null,
            }
          : null,
      })),
    }))
    return { projects: summaries }
  })
}

export async function POST(req: Request) {
  try {
    const body = await req.json()
    const name = String(body?.name || '').trim()
    const description = String(body?.description || '').trim()
    if (name.length < 2) return badRequest('project name must be at least 2 characters')
    const { requireUser } = await import('@/lib/session')
    const user = await requireUser()
    const project = await db.project.create({
      data: { userId: user.id, name, description },
      select: { id: true, name: true, description: true },
    })
    await db.auditLog.create({ data: { userId: user.id, action: 'project.create', target: project.id } })
    return NextResponse.json({ project })
  } catch (err: any) {
    if (err?.message === 'Unauthorized') return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
    return NextResponse.json({ error: err?.message || 'failed' }, { status: 400 })
  }
}
