import { describe, expect, it } from 'vitest'
import { issueSession, readSession, SESSION_TTL_SECONDS } from './sessions'

const secret = 's'.repeat(32)

describe('session tokens', () => {
  it('round-trips the GitHub user id until it expires', () => {
    const { token } = issueSession(secret, 42, 1000)
    expect(readSession(secret, token, 1001)).toEqual({ sub: 42, iat: 1000, exp: 1000 + SESSION_TTL_SECONDS })
    expect(readSession(secret, token, 1000 + SESSION_TTL_SECONDS)).toBeNull()
  })

  it('rejects another secret, an edited payload, and junk', () => {
    const { token } = issueSession(secret, 42, 1000)
    expect(readSession('t'.repeat(32), token, 1001)).toBeNull()
    const [prefix, , mac] = token.split('.')
    const forged = Buffer.from(JSON.stringify({ sub: 1, iat: 1000, exp: 9e9 })).toString('base64url')
    expect(readSession(secret, `${prefix}.${forged}.${mac}`, 1001)).toBeNull()
    expect(readSession(secret, 'fs1.x', 1001)).toBeNull()
    expect(readSession(secret, `${token}.extra`, 1001)).toBeNull()
  })
})
