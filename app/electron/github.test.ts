import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { GITHUB_SIGN_IN_REQUIRED, GitHubSignInRequired } from '../shared/remote'

const { execCli, githubFetch, githubToken } = vi.hoisted(() => ({
  execCli: vi.fn(),
  githubFetch: vi.fn(),
  githubToken: vi.fn()
}))
vi.mock('electron', () => ({ app: { getAppPath: () => '/mock/app' } }))
vi.mock('./exec-cli', () => ({ execCli }))
vi.mock('./remote', () => ({ githubFetch, githubToken }))
vi.mock('./git-credential-broker', async (original) => ({
  ...(await original<typeof import('./git-credential-broker')>()),
  grantCredential: async () => ({ socket: '/mock/cred.sock', nonce: 'one-use' })
}))

import {
  createPullRequest,
  githubGitEnv,
  githubInfo,
  mergePullRequest,
  noPullRequestMessage,
  normalizeCheckState,
  parseStatusCheckRollup
} from './github'

type Cli = { code: number; out: string; err: string }

const ok = (out = ''): Cli => ({ code: 0, out, err: '' })
const fail = (err: string): Cli => ({ code: 1, out: '', err })
const reply = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status })

const ORIGIN = 'origin\thttps://github.com/acme/repo.git (fetch)\norigin\thttps://github.com/acme/repo.git (push)\n'
/** What `git remote -v` prints; a test swaps it to change the repository. */
let remotes = ORIGIN
/** What `git log` prints for the commits ahead of the base. */
let commitLog = ''
/** The gh CLI's answers by its first two arguments; a missing entry is "command not found". */
let gh: Record<string, Cli> = {}
/** The pull requests GraphQL finds for the branch, and the one it shows. */
let found: unknown[] = []
let view: unknown
/** REST answers by `METHOD /path`. */
let rest = new Map<string, (init?: RequestInit) => Response>()

const GH_READY = { '--version': ok('gh version 2'), 'auth status': ok('Logged in') }

const checkRun = (name: string, status: string, conclusion: string | null, isRequired = true) => ({
  __typename: 'CheckRun',
  name,
  status,
  conclusion,
  isRequired
})

const pullRequest = (extra: object = {}, checks: object[] = []) => ({
  number: 9,
  state: 'OPEN',
  mergeable: 'MERGEABLE',
  ...extra,
  commits: { nodes: [{ commit: { statusCheckRollup: { contexts: { nodes: checks } } } }] }
})

const bodyOf = (init?: RequestInit): unknown => JSON.parse(String(init?.body))

/** The clock only moves forward, so the gh readiness one test caches has expired by the next. */
let clock = Date.parse('2026-01-01T00:00:00Z')

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  clock += 10 * 60_000
  vi.setSystemTime(clock)
  remotes = ORIGIN
  commitLog = ''
  gh = {}
  found = [{ number: 9, headRepositoryOwner: { login: 'acme' } }]
  view = pullRequest()
  rest = new Map()
  execCli.mockImplementation(async (bin: string, _cwd: string, args: string[]): Promise<Cli> => {
    if (bin === 'gh') return gh[args.slice(0, 2).join(' ')] ?? fail('gh: command not found')
    if (args[0] === 'rev-parse') return ok('feat/x\n')
    if (args[0] === 'remote') return ok(remotes)
    return ok(commitLog)
  })
  githubFetch.mockImplementation(async (path: string, init?: RequestInit) => {
    if (path === '/graphql') {
      const { query } = bodyOf(init) as { query: string }
      const repository = query.includes('pullRequests(') ? { pullRequests: { nodes: found } } : { pullRequest: view }
      return reply({ data: { repository } })
    }
    return rest.get(`${init?.method ?? 'GET'} ${path}`)?.(init) ?? reply({ message: 'Not Found' }, 404)
  })
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllEnvs()
  execCli.mockReset()
  githubFetch.mockReset()
  githubToken.mockReset()
})

const ghCalls = () => execCli.mock.calls.filter(([bin]) => bin === 'gh')

describe('githubGitEnv', () => {
  it('has nothing to add without a token', async () => {
    githubToken.mockResolvedValue(null)
    await expect(githubGitEnv()).resolves.toBeUndefined()
  })

  it('registers a credential helper for github.com and keeps the token out of the environment', async () => {
    vi.stubEnv('GIT_CONFIG_COUNT', '')
    githubToken.mockResolvedValue('tok')
    const env = await githubGitEnv()
    expect(env?.GIT_CONFIG_KEY_0).toBe('credential.https://github.com.helper')
    // An empty helper first clears the chain, so no other helper is handed the login to store.
    expect(env?.GIT_CONFIG_VALUE_0).toBe('')
    expect(env?.GIT_CONFIG_KEY_1).toBe('credential.https://github.com.helper')
    expect(env?.GIT_CONFIG_VALUE_1).toMatch(/^!/)
    expect(env?.GIT_CONFIG_VALUE_1).toContain('git-credential.js')
    expect(env?.GIT_CONFIG_VALUE_1).not.toContain('tok')
    expect(env?.GIT_CONFIG_VALUE_1).not.toMatch(/Authorization/i)
    expect(env).toMatchObject({
      GIT_TERMINAL_PROMPT: '0',
      ELECTRON_RUN_AS_NODE: '1',
      GIT_CONFIG_COUNT: '2',
      FAROL_GIT_CREDENTIAL_SOCKET: '/mock/cred.sock',
      FAROL_GIT_CREDENTIAL_NONCE: 'one-use'
    })
    expect(Object.values(env ?? {})).not.toContain('tok')
  })

  it('goes after the git configuration the environment already holds', async () => {
    vi.stubEnv('GIT_CONFIG_COUNT', '2')
    githubToken.mockResolvedValue('tok')
    await expect(githubGitEnv()).toMatchObject({
      GIT_CONFIG_COUNT: '4',
      GIT_CONFIG_KEY_2: 'credential.https://github.com.helper',
      GIT_CONFIG_VALUE_2: '',
      GIT_CONFIG_KEY_3: 'credential.https://github.com.helper'
    })
  })
})

describe('noPullRequestMessage', () => {
  it('detects gh\'s empty-branch wording', () => {
    expect(noPullRequestMessage('no pull requests found for branch "feat/x"')).toBe(true)
    expect(noPullRequestMessage('HTTP 401')).toBe(false)
  })
})

describe('normalizeCheckState', () => {
  it('maps pending, passed, failed, skipped, and neutral outcomes', () => {
    expect(normalizeCheckState({ status: 'IN_PROGRESS' })).toBe('pending')
    expect(normalizeCheckState({ status: 'COMPLETED', conclusion: 'SUCCESS' })).toBe('passed')
    expect(normalizeCheckState({ status: 'COMPLETED', conclusion: 'FAILURE' })).toBe('failed')
    expect(normalizeCheckState({ status: 'COMPLETED', conclusion: 'SKIPPED' })).toBe('skipped')
    expect(normalizeCheckState({ status: 'COMPLETED', conclusion: 'NEUTRAL' })).toBe('neutral')
    expect(normalizeCheckState({ state: 'SUCCESS' })).toBe('passed')
    expect(normalizeCheckState({ state: 'PENDING' })).toBe('pending')
  })
})

describe('parseStatusCheckRollup', () => {
  it('parses check runs and status contexts', () => {
    expect(
      parseStatusCheckRollup(
        [
          {
            name: 'build',
            status: 'COMPLETED',
            conclusion: 'SUCCESS',
            detailsUrl: 'https://example.com/build'
          },
          {
            context: 'lint',
            state: 'FAILURE',
            targetUrl: 'https://example.com/lint'
          },
          { name: 'build', status: 'COMPLETED', conclusion: 'FAILURE' }
        ],
        new Set(['lint'])
      )
    ).toEqual([
      { name: 'build', state: 'passed', url: 'https://example.com/build' },
      { name: 'lint', state: 'failed', required: true, url: 'https://example.com/lint' }
    ])
  })

  it('treats a missing rollup as no checks', () => {
    expect(parseStatusCheckRollup(null)).toEqual([])
    expect(parseStatusCheckRollup(undefined)).toEqual([])
  })
})

describe('githubInfo through the API', () => {
  it('returns the branch PR with its checks, which of them are required, and draft state', async () => {
    view = pullRequest(
      { mergeable: 'CONFLICTING', baseRefName: 'staging', url: 'https://github.com/acme/repo/pull/9', isDraft: true },
      [
        checkRun('build', 'COMPLETED', 'SUCCESS'),
        checkRun('test', 'IN_PROGRESS', null),
        { __typename: 'StatusContext', context: 'lint', state: 'SUCCESS', isRequired: false }
      ]
    )
    await expect(githubInfo('/repo')).resolves.toEqual({
      available: true,
      prs: [
        {
          number: 9,
          hasConflicts: true,
          isDraft: true,
          base: 'staging',
          url: 'https://github.com/acme/repo/pull/9',
          checks: {
            state: 'pending',
            pending: 1,
            passed: 2,
            failed: 0,
            skipped: 0,
            neutral: 0,
            checks: [
              { name: 'build', state: 'passed', required: true },
              { name: 'test', state: 'pending', required: true },
              { name: 'lint', state: 'passed' }
            ]
          }
        }
      ]
    })
    expect(ghCalls()).toHaveLength(0)
  })

  it('counts every check as required when branch protection requires none', async () => {
    view = pullRequest({}, [checkRun('build', 'COMPLETED', 'FAILURE', false)])
    await expect(githubInfo('/repo')).resolves.toMatchObject({ prs: [{ checks: { state: 'failed' } }] })
  })

  it('treats a branch with no pull request as available with an empty list', async () => {
    found = []
    await expect(githubInfo('/repo')).resolves.toEqual({ available: true, prs: [] })
  })

  it.each([
    ['a pull request list that is not a list', () => { found = 'oops' as unknown as unknown[] }],
    ['a pull request without a number', () => { found = [{ headRepositoryOwner: { login: 'acme' } }] }],
    ['a view without commits', () => { view = { number: 9, state: 'OPEN' } }]
  ])('reports a fixed message for %s, never a raw error', async (_name, shape) => {
    shape()
    const info = await githubInfo('/repo')
    expect(info).toMatchObject({ available: false, message: 'GitHub sent a reply Farol could not read.' })
  })

  it('ignores a pull request from someone else\'s branch of the same name', async () => {
    found = [{ number: 5, headRepositoryOwner: { login: 'someone-else' } }]
    await expect(githubInfo('/repo')).resolves.toEqual({ available: true, prs: [] })
  })

  it.each(['MERGED', 'CLOSED'])('treats a %s pull request as no pull request', async (state) => {
    view = pullRequest({ state })
    await expect(githubInfo('/repo')).resolves.toEqual({ available: true, prs: [] })
  })

  it('omits a non-http url', async () => {
    view = pullRequest({ url: 'javascript:alert(1)' })
    const info = await githubInfo('/repo')
    expect(info.prs[0]).not.toHaveProperty('url')
  })

  it('looks for pull requests in the upstream repository when the clone is a fork', async () => {
    remotes = 'origin\thttps://github.com/me/repo.git (fetch)\nupstream\tgit@github.com:acme/repo.git (fetch)\n'
    found = [{ number: 9, headRepositoryOwner: { login: 'me' } }]
    await expect(githubInfo('/repo')).resolves.toMatchObject({ prs: [{ number: 9 }] })
    const [, init] = githubFetch.mock.calls[0]!
    expect(bodyOf(init)).toMatchObject({ variables: { owner: 'acme', repo: 'repo', head: 'feat/x' } })
  })

  it('reports GitHub\'s own error without asking gh', async () => {
    githubFetch.mockResolvedValue(reply({ message: 'Bad credentials' }, 502))
    gh = { ...GH_READY }
    await expect(githubInfo('/repo')).resolves.toEqual({ available: false, message: 'Bad credentials', prs: [] })
    expect(ghCalls()).toHaveLength(0)
  })
})

describe('githubInfo without the API', () => {
  it('asks the user to sign in when there is no token and gh cannot help', async () => {
    githubFetch.mockRejectedValue(new GitHubSignInRequired())
    await expect(githubInfo('/repo')).resolves.toEqual({
      available: false,
      signInRequired: true,
      message: GITHUB_SIGN_IN_REQUIRED,
      prs: []
    })
  })

  it('has nothing to ask when the repository has no github.com remote', async () => {
    remotes = 'origin\thttps://gitlab.com/acme/repo.git (fetch)\n'
    await expect(githubInfo('/repo')).resolves.toEqual({
      available: false,
      message: 'This repository has no github.com remote.',
      prs: []
    })
    expect(githubFetch).not.toHaveBeenCalled()
  })

  it('falls back to gh when there is no token', async () => {
    githubFetch.mockRejectedValue(new GitHubSignInRequired())
    gh = {
      ...GH_READY,
      'pr view': ok(
        JSON.stringify({
          number: 12,
          mergeable: 'CONFLICTING',
          baseRefName: 'staging',
          url: 'https://github.com/acme/repo/pull/12',
          isDraft: true,
          statusCheckRollup: [
            { name: 'build', status: 'COMPLETED', conclusion: 'SUCCESS' },
            { name: 'test', status: 'IN_PROGRESS', conclusion: null }
          ]
        })
      ),
      'pr checks': ok('build\tpass\ntest\tpending\n')
    }
    await expect(githubInfo('/repo')).resolves.toEqual({
      available: true,
      prs: [
        {
          number: 12,
          hasConflicts: true,
          isDraft: true,
          base: 'staging',
          url: 'https://github.com/acme/repo/pull/12',
          checks: {
            state: 'pending',
            pending: 1,
            passed: 1,
            failed: 0,
            skipped: 0,
            neutral: 0,
            checks: [
              { name: 'build', state: 'passed', required: true },
              { name: 'test', state: 'pending', required: true }
            ]
          }
        }
      ]
    })
  })

  it('falls back to gh when GitHub cannot be reached, and reads a branch with no PR', async () => {
    githubFetch.mockRejectedValue(new TypeError('fetch failed'))
    gh = { ...GH_READY, 'pr view': fail('no pull requests found for branch "feat/x"') }
    await expect(githubInfo('/repo')).resolves.toEqual({ available: true, prs: [] })
  })

  it.each(['MERGED', 'CLOSED'])('reads a %s pull request from gh as no pull request', async (state) => {
    githubFetch.mockRejectedValue(new GitHubSignInRequired())
    gh = { ...GH_READY, 'pr view': ok(JSON.stringify({ number: 3, state, baseRefName: 'main' })) }
    await expect(githubInfo('/repo')).resolves.toEqual({ available: true, prs: [] })
  })

  it('marks checks unavailable when gh omits statusCheckRollup', async () => {
    githubFetch.mockRejectedValue(new GitHubSignInRequired())
    gh = { ...GH_READY, 'pr view': ok(JSON.stringify({ number: 3, mergeable: 'MERGEABLE' })), 'pr checks': fail('HTTP 404') }
    await expect(githubInfo('/repo')).resolves.toMatchObject({
      available: true,
      prs: [{ number: 3, hasConflicts: false, checks: { state: 'unavailable', checks: [] } }]
    })
  })
})

describe('createPullRequest', () => {
  const created = () => reply({ number: 7, html_url: 'https://github.com/acme/repo/pull/7' }, 201)

  it('opens the PR from the commit and the default branch, and reports the new URL and state', async () => {
    commitLog = 'feat: add the thing\x1fIt does the thing.\x1e'
    rest.set('GET /repos/acme/repo', () => reply({ default_branch: 'main' }))
    let sent: unknown
    rest.set('POST /repos/acme/repo/pulls', (init) => {
      sent = bodyOf(init)
      return created()
    })
    view = pullRequest({ number: 7 })
    const result = await createPullRequest('/repo')
    expect(result).toMatchObject({ ok: true, message: 'Pull request created: https://github.com/acme/repo/pull/7' })
    expect(result.github?.prs[0]).toMatchObject({ number: 7 })
    expect(sent).toEqual({ title: 'feat: add the thing', body: 'It does the thing.', base: 'main', head: 'feat/x' })
  })

  it('names the branch and lists the commits when there are several', async () => {
    commitLog = 'first\x1f\x1esecond\x1f\x1e'
    rest.set('GET /repos/acme/repo', () => reply({ default_branch: 'main' }))
    let sent: unknown
    rest.set('POST /repos/acme/repo/pulls', (init) => {
      sent = bodyOf(init)
      return created()
    })
    await createPullRequest('/repo')
    expect(sent).toMatchObject({ title: 'Feat/x', body: '- first\n- second' })
  })

  it('targets a chosen base, title, and body', async () => {
    let sent: unknown
    rest.set('POST /repos/acme/repo/pulls', (init) => {
      sent = bodyOf(init)
      return created()
    })
    await createPullRequest('/repo', 'staging', 'My change', '## Summary\n\nDid the thing.')
    expect(sent).toEqual({ title: 'My change', body: '## Summary\n\nDid the thing.', base: 'staging', head: 'feat/x' })
  })

  it('opens from a fork with the owner in the head', async () => {
    remotes = 'origin\thttps://github.com/me/repo.git (fetch)\nupstream\thttps://github.com/acme/repo.git (fetch)\n'
    let sent: unknown
    rest.set('POST /repos/acme/repo/pulls', (init) => {
      sent = bodyOf(init)
      return created()
    })
    await createPullRequest('/repo', 'main', 'Title', 'Body')
    expect(sent).toMatchObject({ head: 'me:feat/x' })
  })

  it('refuses a base that git would read as an option', async () => {
    await expect(createPullRequest('/repo', '--output=/tmp/x', 'Title', 'Body')).resolves.toEqual({
      ok: false,
      message: '"--output=/tmp/x" is not a valid base branch name.'
    })
    expect(githubFetch).not.toHaveBeenCalled()
  })

  it('shows what GitHub refused', async () => {
    rest.set('POST /repos/acme/repo/pulls', () =>
      reply({ message: 'Validation Failed', errors: [{ message: 'A pull request already exists for acme:feat/x.' }] }, 422)
    )
    await expect(createPullRequest('/repo', 'main', 'Title', 'Body')).resolves.toEqual({
      ok: false,
      message: 'Validation Failed: A pull request already exists for acme:feat/x.'
    })
  })

  it('falls back to gh and fills the PR from commits when there is no token', async () => {
    githubFetch.mockRejectedValue(new GitHubSignInRequired())
    gh = { ...GH_READY, 'pr create': ok('https://github.com/acme/repo/pull/7\n'), 'pr view': fail('nope') }
    await expect(createPullRequest('/repo')).resolves.toEqual({
      ok: true,
      message: 'Pull request created: https://github.com/acme/repo/pull/7'
    })
    const create = ghCalls().find(([, , args]) => args[1] === 'create')
    expect(create?.[2]).toEqual(['pr', 'create', '--fill'])
  })

  it('gives gh the chosen base, title, and body', async () => {
    githubFetch.mockRejectedValue(new GitHubSignInRequired())
    gh = { ...GH_READY, 'pr create': ok('https://github.com/acme/repo/pull/8\n'), 'pr view': fail('nope') }
    await createPullRequest('/repo', 'staging', 'My change', '## Summary\n\nDid the thing.')
    const create = ghCalls().find(([, , args]) => args[1] === 'create')
    expect(create?.[2]).toEqual([
      'pr',
      'create',
      '--fill',
      '--base',
      'staging',
      '--title',
      'My change',
      '--body',
      '## Summary\n\nDid the thing.'
    ])
  })

  it('surfaces the first line of a gh failure', async () => {
    githubFetch.mockRejectedValue(new GitHubSignInRequired())
    gh = { ...GH_READY, 'pr create': fail('pull request create failed: no commits between main and feat/x') }
    await expect(createPullRequest('/repo')).resolves.toEqual({
      ok: false,
      message: 'pull request create failed: no commits between main and feat/x'
    })
  })

  it('asks the user to sign in when neither the API nor gh can open it', async () => {
    githubFetch.mockRejectedValue(new GitHubSignInRequired())
    await expect(createPullRequest('/repo')).resolves.toEqual({ ok: false, message: GITHUB_SIGN_IN_REQUIRED })
  })
})

describe('mergePullRequest', () => {
  const green = [checkRun('build', 'COMPLETED', 'SUCCESS')]

  it('merges through the API with an explicit squash strategy when checks are green', async () => {
    view = pullRequest({}, green)
    let sent: unknown
    rest.set('PUT /repos/acme/repo/pulls/9/merge', (init) => {
      sent = bodyOf(init)
      return reply({ merged: true, message: 'Pull Request successfully merged' })
    })
    await expect(mergePullRequest('/repo', 'squash')).resolves.toEqual({
      ok: true,
      message: 'Pull Request successfully merged'
    })
    expect(sent).toEqual({ merge_method: 'squash' })
  })

  it('shows why GitHub refused the merge', async () => {
    view = pullRequest({}, green)
    rest.set('PUT /repos/acme/repo/pulls/9/merge', () => reply({ message: 'Pull Request is not mergeable' }, 405))
    await expect(mergePullRequest('/repo', 'merge')).resolves.toEqual({
      ok: false,
      message: 'Pull Request is not mergeable'
    })
  })

  it('refuses draft, conflicting, and pending-check merges', async () => {
    view = pullRequest({ isDraft: true })
    await expect(mergePullRequest('/repo', 'merge')).resolves.toEqual({
      ok: false,
      message: 'Mark the pull request as ready for review before merging.'
    })

    view = pullRequest({ mergeable: 'CONFLICTING', baseRefName: 'main' })
    await expect(mergePullRequest('/repo', 'rebase')).resolves.toEqual({
      ok: false,
      message: 'Resolve merge conflicts with main before merging.'
    })

    view = pullRequest({}, [checkRun('build', 'IN_PROGRESS', null)])
    await expect(mergePullRequest('/repo', 'merge')).resolves.toEqual({
      ok: false,
      message: 'Wait for required checks to finish.'
    })
  })

  it('rejects an unknown strategy before asking GitHub', async () => {
    await expect(mergePullRequest('/repo', 'fast-forward' as 'merge')).resolves.toEqual({
      ok: false,
      message: 'Choose a merge strategy.'
    })
    expect(githubFetch).not.toHaveBeenCalled()
    expect(execCli).not.toHaveBeenCalled()
  })

  it('merges with gh when there is no token', async () => {
    githubFetch.mockRejectedValue(new GitHubSignInRequired())
    gh = {
      ...GH_READY,
      'pr view': ok(JSON.stringify({ number: 9, mergeable: 'MERGEABLE', statusCheckRollup: [{ name: 'build', status: 'COMPLETED', conclusion: 'SUCCESS' }] })),
      'pr checks': ok('build\tpass\n'),
      'pr merge': ok('Pull request successfully merged\n')
    }
    await expect(mergePullRequest('/repo', 'squash')).resolves.toEqual({
      ok: true,
      message: 'Pull request successfully merged'
    })
    expect(ghCalls().at(-1)?.[2]).toEqual(['pr', 'merge', '9', '--squash'])
  })
})
