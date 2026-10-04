import { afterEach, describe, expect, it, vi } from 'vitest'

const { execCli } = vi.hoisted(() => ({
  execCli: vi.fn()
}))
vi.mock('./exec-cli', () => ({ execCli }))

import {
  createPullRequest,
  githubInfo,
  mergePullRequest,
  noPullRequestMessage,
  normalizeCheckState,
  parseStatusCheckRollup
} from './github'

function ok(out: string) {
  return { code: 0, out, err: '' }
}

function fail(err: string) {
  return { code: 1, out: '', err }
}

function authOk() {
  return execCli.mockResolvedValueOnce(ok('gh version 2')).mockResolvedValueOnce(ok('Logged in'))
}

afterEach(() => {
  execCli.mockReset()
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

describe('githubInfo for a finished PR', () => {
  it.each(['MERGED', 'CLOSED'])('treats a %s pull request as no pull request', async (state) => {
    authOk().mockResolvedValueOnce(ok(JSON.stringify({ number: 3, state, baseRefName: 'main' })))
    await expect(githubInfo('/repo')).resolves.toEqual({ available: true, prs: [] })
    expect(execCli).toHaveBeenCalledTimes(3)
  })
})

describe('githubInfo', () => {
  it('returns the current branch PR with checks and draft state', async () => {
    authOk()
      .mockResolvedValueOnce(
        ok(
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
        )
      )
      .mockResolvedValueOnce(ok('build\tpass\ntest\tpending\n'))
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
    expect(execCli.mock.calls[2]?.[2]).toEqual([
      'pr',
      'view',
      '--json',
      'number,mergeable,baseRefName,url,isDraft,statusCheckRollup'
    ])
  })

  it('marks checks unavailable when statusCheckRollup is omitted', async () => {
    authOk()
      .mockResolvedValueOnce(ok(JSON.stringify({ number: 3, mergeable: 'MERGEABLE' })))
      .mockResolvedValueOnce(fail('HTTP 404'))
    await expect(githubInfo('/repo')).resolves.toEqual({
      available: true,
      prs: [
        {
          number: 3,
          hasConflicts: false,
          checks: {
            state: 'unavailable',
            pending: 0,
            passed: 0,
            failed: 0,
            skipped: 0,
            neutral: 0,
            checks: []
          }
        }
      ]
    })
  })

  it('treats an empty rollup as no checks', async () => {
    authOk()
      .mockResolvedValueOnce(
        ok(JSON.stringify({ number: 4, mergeable: 'MERGEABLE', statusCheckRollup: [] }))
      )
      .mockResolvedValueOnce(ok(''))
    await expect(githubInfo('/repo')).resolves.toMatchObject({
      available: true,
      prs: [{ number: 4, checks: { state: 'none', checks: [] } }]
    })
  })

  it('treats no PR for this branch as available with an empty list', async () => {
    authOk().mockResolvedValueOnce(fail('no pull requests found for branch "feat/x"'))
    await expect(githubInfo('/repo')).resolves.toEqual({ available: true, prs: [] })
  })

  it('omits a non-http url from gh', async () => {
    authOk()
      .mockResolvedValueOnce(
        ok(
          JSON.stringify({
            number: 3,
            mergeable: 'MERGEABLE',
            url: 'javascript:alert(1)',
            statusCheckRollup: []
          })
        )
      )
      .mockResolvedValueOnce(ok(''))
    await expect(githubInfo('/repo')).resolves.toEqual({
      available: true,
      prs: [
        {
          number: 3,
          hasConflicts: false,
          checks: {
            state: 'none',
            pending: 0,
            passed: 0,
            failed: 0,
            skipped: 0,
            neutral: 0,
            checks: []
          }
        }
      ]
    })
  })
})

describe('createPullRequest', () => {
  it('fills the PR from commits and reports the new URL', async () => {
    authOk().mockResolvedValueOnce(ok('https://github.com/acme/repo/pull/7\n'))
    await expect(createPullRequest('/repo')).resolves.toEqual({
      ok: true,
      message: 'Pull request created: https://github.com/acme/repo/pull/7'
    })
    expect(execCli.mock.calls[2]?.[2]).toEqual(['pr', 'create', '--fill'])
  })

  it('targets a chosen base, title, and body', async () => {
    authOk().mockResolvedValueOnce(ok('https://github.com/acme/repo/pull/8\n'))
    await expect(
      createPullRequest('/repo', 'staging', 'My change', '## Summary\n\nDid the thing.')
    ).resolves.toEqual({
      ok: true,
      message: 'Pull request created: https://github.com/acme/repo/pull/8'
    })
    expect(execCli.mock.calls[2]?.[2]).toEqual([
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
    authOk().mockResolvedValueOnce(
      fail('pull request create failed: no commits between main and feat/x')
    )
    await expect(createPullRequest('/repo')).resolves.toEqual({
      ok: false,
      message: 'pull request create failed: no commits between main and feat/x'
    })
  })

  it('stops before gh runs when the CLI is missing', async () => {
    execCli.mockResolvedValueOnce(fail('command not found'))
    await expect(createPullRequest('/repo')).resolves.toEqual({
      ok: false,
      message: 'Install the GitHub CLI (gh) to open pull requests.'
    })
    expect(execCli).toHaveBeenCalledTimes(1)
  })
})

describe('mergePullRequest', () => {
  it('merges with an explicit squash strategy when checks are green', async () => {
    authOk()
      .mockResolvedValueOnce(
        ok(
          JSON.stringify({
            number: 9,
            mergeable: 'MERGEABLE',
            statusCheckRollup: [{ name: 'build', status: 'COMPLETED', conclusion: 'SUCCESS' }]
          })
        )
      )
      .mockResolvedValueOnce(ok('build\tpass\n'))
      .mockResolvedValueOnce(ok('Pull request successfully merged\n'))
    await expect(mergePullRequest('/repo', 'squash')).resolves.toEqual({
      ok: true,
      message: 'Pull request successfully merged'
    })
    expect(execCli.mock.calls.at(-1)?.[2]).toEqual(['pr', 'merge', '9', '--squash'])
  })

  it('refuses draft, conflicting, and pending-check merges', async () => {
    authOk().mockResolvedValueOnce(
      ok(
        JSON.stringify({
          number: 1,
          mergeable: 'MERGEABLE',
          isDraft: true,
          statusCheckRollup: []
        })
      )
    ).mockResolvedValueOnce(ok(''))
    await expect(mergePullRequest('/repo', 'merge')).resolves.toEqual({
      ok: false,
      message: 'Mark the pull request as ready for review before merging.'
    })

    authOk()
      .mockResolvedValueOnce(
        ok(
          JSON.stringify({
            number: 2,
            mergeable: 'CONFLICTING',
            baseRefName: 'main',
            statusCheckRollup: []
          })
        )
      )
      .mockResolvedValueOnce(ok(''))
    await expect(mergePullRequest('/repo', 'rebase')).resolves.toEqual({
      ok: false,
      message: 'Resolve merge conflicts with main before merging.'
    })

    authOk()
      .mockResolvedValueOnce(
        ok(
          JSON.stringify({
            number: 3,
            mergeable: 'MERGEABLE',
            statusCheckRollup: [{ name: 'build', status: 'IN_PROGRESS', conclusion: null }]
          })
        )
      )
      .mockResolvedValueOnce(ok('build\tpass\n'))
    await expect(mergePullRequest('/repo', 'merge')).resolves.toEqual({
      ok: false,
      message: 'Wait for required checks to finish.'
    })
  })

  it('rejects an unknown strategy before calling gh', async () => {
    await expect(mergePullRequest('/repo', 'fast-forward' as 'merge')).resolves.toEqual({
      ok: false,
      message: 'Choose a merge strategy.'
    })
    expect(execCli).not.toHaveBeenCalled()
  })
})
