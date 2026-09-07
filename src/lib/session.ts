import { cookies, headers } from 'next/headers'
import { db } from '@/lib/db'
import { verifySessionToken } from '@/lib/auth'
import type { User } from '@prisma/client'

export const SESSION_COOKIE = 'bfa_session'
export const TOKEN_STORAGE_KEY = 'bfa_token'

export type SafeUser = Pick<User, 'id' | 'email' | 'name' | 'role'>

/**
 * Cookie policy: the app may be viewed as a top-level site (cookie works with
 * any SameSite) OR embedded in a cross-site iframe (chat preview panels), where
 * browsers only accept `SameSite=None; Secure`. localhost is treated as a
 * trustworthy origin by Chrome/Firefox, so the Secure flag is also accepted in
 * local development. For contexts where even those cookies are blocked, the
 * client falls back to an Authorization: Bearer header with the same signed
 * token (see getCurrentUser).
 */
const COOKIE_OPTS = {
  httpOnly: true,
  sameSite: 'none' as const,
  secure: true,
  path: '/',
  maxAge: 60 * 60 * 24 * 7,
}

export async function setSessionCookie(userId: string): Promise<string> {
  const { signSessionToken } = await import('@/lib/auth')
  const token = signSessionToken(userId)
  const store = await cookies()
  store.set(SESSION_COOKIE, token, COOKIE_OPTS)
  return token
}

export async function clearSessionCookie() {
  const store = await cookies()
  store.set(SESSION_COOKIE, '', { ...COOKIE_OPTS, maxAge: 0 })
}

/**
 * Get the authenticated user for the current request, or null.
 * Reads the session cookie first; falls back to an Authorization: Bearer
 * header for browsers that block third-party cookies in embedded contexts.
 */
export async function getCurrentUser(): Promise<SafeUser | null> {
  const store = await cookies()
  let token = store.get(SESSION_COOKIE)?.value
  if (!token) {
    const h = await headers()
    const auth = h.get('authorization')
    if (auth && auth.toLowerCase().startsWith('bearer ')) {
      token = auth.slice(7).trim()
    }
  }
  if (!token) return null
  const payload = verifySessionToken(token)
  if (!payload) return null
  const user = await db.user.findUnique({
    where: { id: payload.userId },
    select: { id: true, email: true, name: true, role: true },
  })
  return user
}

/** Require auth in an API route; throws a typed marker the route handler converts to 401. */
export class Unauthorized extends Error {
  constructor() {
    super('Unauthorized')
  }
}

export async function requireUser(): Promise<SafeUser> {
  const user = await getCurrentUser()
  if (!user) throw new Unauthorized()
  return user
}
