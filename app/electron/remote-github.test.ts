import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { store } = vi.hoisted(() => ({ store: new Map<string, string>() }))
vi.mock('electron', () => ({ shell: { openExternal: vi.fn() } }))
vi.mock('./secrets', () => ({
  peekSecret: (name: string) => store.get(name) ?? null,
  setSecret: (name: string, value: string) => void store.set(name, value),
  clearSecret: (name: string) => void store.delete(name)
}))
vi.mock('./service-url', () => ({ SERVICE_URL: 'https://service.test' }))
vi.mock('./checkout-snapshot', () => ({}))
vi.mock('./snapshot-manifest', () => ({}))
vi.mock('./sandbox', () => ({}))

import { GitHubSignInRequired } from '../shared/remote'
import { githubFetch, githubToken, signOutRemote, startRemoteSignIn, waitRemoteSignIn } from './remote'

const reply = (status: number, body: unknown = {}) => ({ ok: status < 400, status, json: () => Promise.resolve(body) })
const inMinutes = (minutes: number) => new Date(Date.now() + minutes * 60_000).toISOString()
const saveGrant = (grant: object) => store.set('githubGrant', JSON.stringify(grant))
const stubFetch = (...replies: unknown[]) => {
  const fetchMock = vi.fn()
  for (const next of replies) fetchMock.mockResolvedValueOnce(next)
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

/** A fetch whose answer the test gives by hand, so a request can be in flight while the credentials change. */
const stubInFlight = () => {
  let answer!: (response: unknown) => void
  const fetchMock = vi.fn().mockReturnValueOnce(
    new Promise((resolve) => {
      answer = resolve
    })
  )
  vi.stubGlobal('fetch', fetchMock)
  return { answer: (response: unknown) => answer(response), sent: () => vi.waitFor(() => expect(fetchMock).toHaveBeenCalled()) }
}
/** A grant about to expire, so the next token request refreshes it. */
const expiring = (token: string) => saveGrant({ token, refreshToken: `rt_${token}`, expiresAt: inMinutes(1) })

beforeEach(() => {
  store.clear()
  store.set('remoteSession', 'fs1.session')
})
afterEach(() => vi.unstubAllGlobals())

describe('githubToken', () => {
  it('is null when nobody signed in with GitHub', async () => {
    await expect(githubToken()).resolves.toBeNull()
  })

  it('returns a token that is not about to expire without asking the service', async () => {
    const fetchMock = stubFetch()
    saveGrant({ token: 'gho_old', refreshToken: 'rt_old', expiresAt: inMinutes(120) })
    await expect(githubToken()).resolves.toBe('gho_old')
    saveGrant({ token: 'gho_forever' })
    await expect(githubToken()).resolves.toBe('gho_forever')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('ignores a stored grant it cannot read', async () => {
    store.set('githubGrant', 'not json')
    await expect(githubToken()).resolves.toBeNull()
  })

  it('refreshes a token that is about to expire, through the service, once for calls made together', async () => {
    const next = { token: 'gho_new', refreshToken: 'rt_new', expiresAt: inMinutes(480) }
    const fetchMock = stubFetch(reply(200, { github: next }))
    saveGrant({ token: 'gho_old', refreshToken: 'rt_old', expiresAt: inMinutes(1) })

    await expect(Promise.all([githubToken(), githubToken()])).resolves.toEqual(['gho_new', 'gho_new'])

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]!
    expect(String(url)).toBe('https://service.test/v1/auth/github/refresh')
    expect(JSON.parse(init.body)).toEqual({ refreshToken: 'rt_old' })
    expect(init.headers).toMatchObject({ Authorization: 'Bearer fs1.session' })
    expect(JSON.parse(store.get('githubGrant')!)).toEqual(next)
  })

  it('keeps only the fields it uses, and keeps the old grant when the service sends no token', async () => {
    stubFetch(reply(200, { github: { token: 'gho_new', scope: 'repo', extra: 1 } }), reply(200, { github: {} }))
    saveGrant({ token: 'gho_old', refreshToken: 'rt_old', expiresAt: inMinutes(1) })
    await expect(githubToken()).resolves.toBe('gho_new')
    expect(JSON.parse(store.get('githubGrant')!)).toEqual({ token: 'gho_new' })

    saveGrant({ token: 'gho_old', refreshToken: 'rt_old', expiresAt: inMinutes(1) })
    await expect(githubToken()).resolves.toBe('gho_old')
    expect(JSON.parse(store.get('githubGrant')!)).toMatchObject({ token: 'gho_old' })
  })

  it('forgets the grant when GitHub no longer accepts the sign-in', async () => {
    stubFetch(reply(400, { error: 'GitHub no longer accepts this sign-in; sign in again' }))
    saveGrant({ token: 'gho_old', refreshToken: 'rt_old', expiresAt: inMinutes(1) })
    await expect(githubToken()).resolves.toBeNull()
    expect(store.has('githubGrant')).toBe(false)
  })

  it('forgets the GitHub token with the session when the service no longer accepts the session', async () => {
    stubFetch(reply(401, { error: 'Missing, invalid or expired token' }))
    saveGrant({ token: 'gho_old', refreshToken: 'rt_old', expiresAt: inMinutes(1) })
    await expect(githubToken()).resolves.toBeNull()
    expect(store.has('githubGrant')).toBe(false)
    expect(store.has('remoteSession')).toBe(false)
  })

  it('keeps the grant, and the token it still has, when the service cannot be reached', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('fetch failed')))
    saveGrant({ token: 'gho_old', refreshToken: 'rt_old', expiresAt: inMinutes(1) })
    await expect(githubToken()).resolves.toBe('gho_old')
    expect(store.has('githubGrant')).toBe(true)

    stubFetch(reply(503, { error: 'busy' }))
    await expect(githubToken()).resolves.toBe('gho_old')
    expect(store.has('githubGrant')).toBe(true)
  })
})

describe('githubFetch', () => {
  it('calls the GitHub API with the token and never lets the caller replace it', async () => {
    const fetchMock = stubFetch(reply(200))
    saveGrant({ token: 'gho_old' })
    await githubFetch('/user', { headers: { Authorization: 'Bearer other', 'X-Extra': '1' } })
    const [url, init] = fetchMock.mock.calls[0]!
    expect(url).toBe('https://api.github.com/user')
    expect(init.headers).toMatchObject({
      Authorization: 'Bearer gho_old',
      Accept: 'application/vnd.github+json',
      'X-Extra': '1'
    })
    expect(init.signal).toBeInstanceOf(AbortSignal)
  })

  it('refuses a path that could lead the token to another host', async () => {
    const fetchMock = stubFetch(reply(200))
    saveGrant({ token: 'gho_old' })
    for (const path of ['user', '//evil.example/x', '/@evil.example/x', '/\\evil.example']) {
      await expect(githubFetch(path)).rejects.toThrow('Not a GitHub API path')
    }
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('needs a token, and does not call GitHub without one', async () => {
    const fetchMock = stubFetch()
    await expect(githubFetch('/user')).rejects.toBeInstanceOf(GitHubSignInRequired)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('forgets a token GitHub rejects and asks for a new sign-in', async () => {
    stubFetch(reply(401, { message: 'Bad credentials' }))
    saveGrant({ token: 'gho_revoked' })
    await expect(githubFetch('/user')).rejects.toBeInstanceOf(GitHubSignInRequired)
    expect(store.has('githubGrant')).toBe(false)
  })
})

describe('credentials that change while a request is in flight', () => {
  it('does not bring a grant back after sign-out when a refresh finishes late', async () => {
    const service = stubInFlight()
    expiring('gho_a')
    const token = githubToken()
    await service.sent()

    signOutRemote()
    service.answer(reply(200, { github: { token: 'gho_a2', refreshToken: 'rt_a2' } }))

    await expect(token).resolves.toBeNull()
    expect(store.has('githubGrant')).toBe(false)
  })

  it('does not replace a newer sign-in with the answer to an older refresh', async () => {
    const service = stubInFlight()
    expiring('gho_a')
    const token = githubToken()
    await service.sent()

    saveGrant({ token: 'gho_b', refreshToken: 'rt_b', expiresAt: inMinutes(480) })
    service.answer(reply(200, { github: { token: 'gho_a2' } }))

    await expect(token).resolves.toBe('gho_b')
    expect(JSON.parse(store.get('githubGrant')!)).toMatchObject({ token: 'gho_b', refreshToken: 'rt_b' })
  })

  it('does not forget a newer sign-in when the older refresh is refused late', async () => {
    const service = stubInFlight()
    expiring('gho_a')
    const token = githubToken()
    await service.sent()

    saveGrant({ token: 'gho_b' })
    service.answer(reply(400, { error: 'GitHub no longer accepts this sign-in; sign in again' }))

    await expect(token).resolves.toBe('gho_b')
    expect(JSON.parse(store.get('githubGrant')!)).toEqual({ token: 'gho_b' })
  })

  it('does not forget a newer token when GitHub refuses an older one late', async () => {
    const service = stubInFlight()
    saveGrant({ token: 'gho_a' })
    const call = githubFetch('/user')
    await service.sent()

    saveGrant({ token: 'gho_b' })
    service.answer(reply(401, { message: 'Bad credentials' }))

    await expect(call).rejects.toBeInstanceOf(GitHubSignInRequired)
    expect(JSON.parse(store.get('githubGrant')!)).toEqual({ token: 'gho_b' })
  })
})

describe('signing in and out', () => {
  const device = reply(200, {
    deviceCode: 'dc',
    userCode: 'ABCD-1234',
    verificationUri: 'https://github.com/login/device',
    interval: 0,
    expiresIn: 900
  })

  it('asks the service for GitHub access and keeps the GitHub token it hands back beside the session', async () => {
    const fetchMock = stubFetch(device, reply(200, { status: 'ok', token: 'fs1.new', github: { token: 'gho_new', refreshToken: 'rt' } }))
    await startRemoteSignIn()
    await expect(waitRemoteSignIn()).resolves.toEqual({})

    const [start, poll] = fetchMock.mock.calls.map(([url, init]) => [String(url), JSON.parse(init.body)])
    expect(start).toEqual(['https://service.test/v1/auth/device', { githubAccess: true }])
    expect(poll).toEqual(['https://service.test/v1/auth/device/token', { deviceCode: 'dc', githubAccess: true }])
    expect(store.get('remoteSession')).toBe('fs1.new')
    expect(JSON.parse(store.get('githubGrant')!)).toEqual({ token: 'gho_new', refreshToken: 'rt' })
  })

  it('drops an older GitHub token when the service sends none', async () => {
    saveGrant({ token: 'gho_old' })
    stubFetch(device, reply(200, { status: 'ok', token: 'fs1.new' }))
    await startRemoteSignIn()
    await expect(waitRemoteSignIn()).resolves.toEqual({})
    expect(store.has('githubGrant')).toBe(false)
  })

  it('forgets the session and the GitHub token on sign-out', () => {
    saveGrant({ token: 'gho_old' })
    signOutRemote()
    expect(store.has('remoteSession')).toBe(false)
    expect(store.has('githubGrant')).toBe(false)
  })
})
