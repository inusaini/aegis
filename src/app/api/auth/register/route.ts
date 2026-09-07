import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { hashPassword } from '@/lib/auth'
import { setSessionCookie } from '@/lib/session'

export async function POST(req: Request) {
  try {
    const body = await req.json()
    const email = String(body?.email || '').toLowerCase().trim()
    const name = String(body?.name || '').trim()
    const password = String(body?.password || '')
    if (!email.includes('@')) return NextResponse.json({ error: 'invalid email' }, { status: 400 })
    if (password.length < 8) return NextResponse.json({ error: 'password must be at least 8 characters' }, { status: 400 })

    const existing = await db.user.findUnique({ where: { email } })
    if (existing) return NextResponse.json({ error: 'email already registered' }, { status: 409 })

    const user = await db.user.create({
      data: { email, name: name || email.split('@')[0], passwordHash: hashPassword(password) },
      select: { id: true, email: true, name: true, role: true },
    })
    await db.auditLog.create({ data: { userId: user.id, action: 'auth.register', target: email } })
    const token = await setSessionCookie(user.id)
    return NextResponse.json({ user, token })
  } catch (err: any) {
    return NextResponse.json({ error: err?.message || 'registration failed' }, { status: 400 })
  }
}
