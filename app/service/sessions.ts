import { createHmac, timingSafeEqual } from 'crypto'

/**
 * Session tokens the service issues after a GitHub sign-in: `fs1.<payload>.<mac>`,
 * where the payload is base64url JSON `{ sub, iat, exp }` (GitHub user id, unix
 * seconds) and the mac is an HMAC-SHA256 over it with the service's session secret.
 * Nothing is stored per session; revocation is per user (`users.ts`).
 */

export interface SessionClaims {
  sub: number
  iat: number
  exp: number
}

export const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60

const PREFIX = 'fs1'

const mac = (secret: string, payload: string): Buffer => createHmac('sha256', secret).update(`${PREFIX}.${payload}`).digest()

export function issueSession(
  secret: string,
  githubId: number,
  now = Math.floor(Date.now() / 1000)
): { token: string; expiresAt: string } {
  const claims: SessionClaims = { sub: githubId, iat: now, exp: now + SESSION_TTL_SECONDS }
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url')
  return {
    token: `${PREFIX}.${payload}.${mac(secret, payload).toString('base64url')}`,
    expiresAt: new Date(claims.exp * 1000).toISOString()
  }
}

export const isSessionToken = (token: string): boolean => token.startsWith(`${PREFIX}.`)

/** The claims of a well-formed, correctly signed, unexpired token; otherwise null. */
export function readSession(secret: string, token: string, now = Math.floor(Date.now() / 1000)): SessionClaims | null {
  const [prefix, payload, signature, ...rest] = token.split('.')
  if (prefix !== PREFIX || !payload || !signature || rest.length) return null
  const expected = mac(secret, payload)
  const actual = Buffer.from(signature, 'base64url')
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null
  try {
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as SessionClaims
    if (!Number.isInteger(claims.sub) || !Number.isInteger(claims.iat) || !Number.isInteger(claims.exp)) return null
    return claims.exp > now ? claims : null
  } catch {
    return null
  }
}
