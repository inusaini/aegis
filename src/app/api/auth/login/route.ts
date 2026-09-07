import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { verifyPassword } from '@/lib/auth'
import { setSessionCookie } from '@/lib/session'

export async function POST(req: Request) {
  try {
    const body = await req.json()
    const email = String(body?.email || '').toLowerCase().trim()
    const password = String(body?.password || '')
    const user = await db.user.findUnique({ where: { email } })
    if (!user || !verifyPassword(password, user.passwordHash)) {
      return NextResponse.json({ error: 'invalid credentials' }, { status: 401 })
    }
    const token = await setSessionCookie(user.id)
    await db.auditLog.create({ data: { userId: user.id, action: 'auth.login', target: email } })
    return NextResponse.json({ user: { id: user.id, email: user.email, name: user.name, role: user.role }, token })
  } catch (err: any) {
    return NextResponse.json({ error: err?.message || 'login failed' }, { status: 400 })
  }
}
