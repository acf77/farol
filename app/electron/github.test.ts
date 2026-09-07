import { afterEach, describe, expect, it, vi } from 'vitest'

const { execCli } = vi.hoisted(() => ({
  execCli: vi.fn()
}))
vi.mock('./exec-cli', () => ({ execCli }))

import { githubInfo, noPullRequestMessage } from './github'

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
            mergeable: 'CONFLICTING'
          })
        )
      )
    await expect(githubInfo('/repo')).resolves.toEqual({
      available: true,
      prs: [
        {
          number: 12,
          hasConflicts: true
        }
      ]
    })
    expect(execCli.mock.calls[2]?.[2]).toEqual([
      'pr',
      'view',
      '--json',
      'number,mergeable'
    ])
  })

  it('treats no PR for this branch as available with an empty list', async () => {
    execCli
      .mockResolvedValueOnce(ok('gh version 2'))
      .mockResolvedValueOnce(ok('Logged in'))
      .mockResolvedValueOnce(fail('no pull requests found for branch "feat/x"'))
    await expect(githubInfo('/repo')).resolves.toEqual({ available: true, prs: [] })
  })
})
