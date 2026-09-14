import { afterEach, describe, expect, it, vi } from 'vitest'

const { execCli } = vi.hoisted(() => ({
  execCli: vi.fn()
}))
vi.mock('./exec-cli', () => ({ execCli }))

import { createPullRequest, githubInfo, noPullRequestMessage } from './github'

function ok(out: string) {
  return { code: 0, out, err: '' }
}

function fail(err: string) {
  return { code: 1, out: '', err }
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

describe('githubInfo', () => {
  it('returns only the current branch PR', async () => {
    execCli
      .mockResolvedValueOnce(ok('gh version 2'))
      .mockResolvedValueOnce(ok('Logged in'))
      .mockResolvedValueOnce(
        ok(
          JSON.stringify({
            number: 12,
            mergeable: 'CONFLICTING',
            baseRefName: 'staging',
            url: 'https://github.com/acme/repo/pull/12'
          })
        )
      )
    await expect(githubInfo('/repo')).resolves.toEqual({
      available: true,
      prs: [
        {
          number: 12,
          hasConflicts: true,
          base: 'staging',
          url: 'https://github.com/acme/repo/pull/12'
        }
      ]
    })
    expect(execCli.mock.calls[2]?.[2]).toEqual([
      'pr',
      'view',
      '--json',
      'number,mergeable,baseRefName,url'
    ])
  })

  it('treats no PR for this branch as available with an empty list', async () => {
    execCli
      .mockResolvedValueOnce(ok('gh version 2'))
      .mockResolvedValueOnce(ok('Logged in'))
      .mockResolvedValueOnce(fail('no pull requests found for branch "feat/x"'))
    await expect(githubInfo('/repo')).resolves.toEqual({ available: true, prs: [] })
  })

  it('omits a non-http url from gh', async () => {
    execCli
      .mockResolvedValueOnce(ok('gh version 2'))
      .mockResolvedValueOnce(ok('Logged in'))
      .mockResolvedValueOnce(
        ok(JSON.stringify({ number: 3, mergeable: 'MERGEABLE', url: 'javascript:alert(1)' }))
      )
    await expect(githubInfo('/repo')).resolves.toEqual({
      available: true,
      prs: [{ number: 3, hasConflicts: false }]
    })
  })
})

describe('createPullRequest', () => {
  it('fills the PR from commits and reports the new URL', async () => {
    execCli
      .mockResolvedValueOnce(ok('gh version 2'))
      .mockResolvedValueOnce(ok('Logged in'))
      .mockResolvedValueOnce(ok('https://github.com/acme/repo/pull/7\n'))
    await expect(createPullRequest('/repo')).resolves.toEqual({
      ok: true,
      message: 'Pull request created: https://github.com/acme/repo/pull/7'
    })
    expect(execCli.mock.calls[2]?.[2]).toEqual(['pr', 'create', '--fill'])
  })

  it('targets a chosen base and title', async () => {
    execCli
      .mockResolvedValueOnce(ok('gh version 2'))
      .mockResolvedValueOnce(ok('Logged in'))
      .mockResolvedValueOnce(ok('https://github.com/acme/repo/pull/8\n'))
    await expect(createPullRequest('/repo', 'staging', 'My change')).resolves.toEqual({
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
      'My change'
    ])
  })

  it('surfaces the first line of a gh failure', async () => {
    execCli
      .mockResolvedValueOnce(ok('gh version 2'))
      .mockResolvedValueOnce(ok('Logged in'))
      .mockResolvedValueOnce(fail('pull request create failed: no commits between main and feat/x'))
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
