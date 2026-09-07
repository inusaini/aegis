import crypto from 'crypto'

// ============================================================
// Password hashing (scrypt — no external deps)
// ============================================================

const SCRYPT_N = 16384, SCRYPT_R = 8, SCRYPT_P = 1, KEYLEN = 64

export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16).toString('hex')
  const hash = crypto.scryptSync(password, salt, KEYLEN, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P }).toString('hex')
  return `scrypt:${salt}:${hash}`
}

export function verifyPassword(password: string, stored: string): boolean {
  try {
    const [scheme, salt, hash] = stored.split(':')
    if (scheme !== 'scrypt' || !salt || !hash) return false
    const derived = crypto.scryptSync(password, salt, KEYLEN, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P })
    const expected = Buffer.from(hash, 'hex')
    return derived.length === expected.length && crypto.timingSafeEqual(derived, expected)
  } catch {
    return false
  }
}

// ============================================================
// Session tokens: signed HMAC payload "userId.expiry"
// ============================================================

function getSecret(): string {
  return process.env.SESSION_SECRET || 'aegis-dev-secret-change-me'
}

export function signSessionToken(userId: string, ttlMs: number = 1000 * 60 * 60 * 24 * 7): string {
  const expiry = Date.now() + ttlMs
  const payload = `${userId}.${expiry}`
  const sig = crypto.createHmac('sha256', getSecret()).update(payload).digest('base64url')
  return `${payload}.${sig}`
}

export function verifySessionToken(token: string): { userId: string } | null {
  try {
    const parts = token.split('.')
    if (parts.length !== 3) return null
    const [userId, expiryStr, sig] = parts
    const expiry = parseInt(expiryStr, 10)
    if (!expiry || Date.now() > expiry) return null
    const expected = crypto.createHmac('sha256', getSecret()).update(`${userId}.${expiryStr}`).digest('base64url')
    const a = Buffer.from(sig), b = Buffer.from(expected)
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null
    return { userId }
  } catch {
    return null
  }
}
