import { db } from '@/lib/db'
import { withAuth } from '@/server/api-helpers'

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  return withAuth(async (user) => {
    const project = await db.project.findFirst({ where: { id, userId: user.id } })
    if (!project) throw new Error('project not found')
    const memories = await db.memory.findMany({
      where: { projectId: id },
      orderBy: { createdAt: 'desc' },
      take: 50,
    })
    return {
      memories: memories.map((m) => ({
        id: m.id,
        kind: m.kind,
        category: m.category,
        content: m.content,
        source: m.source,
        confidence: m.confidence,
        createdAt: m.createdAt.toISOString(),
      })),
    }
  })
}

/** POST — add a user-provided rule (spec §18: user rules are first-class memory). */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  return withAuth(async (user) => {
    const project = await db.project.findFirst({ where: { id, userId: user.id } })
    if (!project) throw new Error('project not found')
    const body = await req.json().catch(() => ({}))
    const content = String(body?.content || '').trim()
    const category = ['architecture', 'convention', 'quirk', 'compatibility', 'decision', 'rule'].includes(body?.category) ? body.category : 'rule'
    if (content.length < 5) throw new Error('memory content too short')
    const memory = await db.memory.create({
      data: { projectId: id, userId: user.id, kind: 'user_rule', category, content, source: 'user', confidence: 1.0 },
    })
    return { memory: { id: memory.id, kind: memory.kind, category: memory.category, content: memory.content } }
  })
}

export const dynamic = 'force-dynamic'
