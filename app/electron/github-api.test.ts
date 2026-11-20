import { afterEach, describe, expect, it, vi } from 'vitest'

const { execCli } = vi.hoisted(() => ({ execCli: vi.fn() }))
vi.mock('./exec-cli', () => ({ execCli }))
vi.mock('./remote', () => ({ githubFetch: vi.fn() }))

import { isSafeBranchName } from '../shared/git-status'
import { GitHubUnavailable, parseGitHubRemote, repoRef } from './github-api'

const ok = (out: string) => ({ code: 0, out, err: '' })

/** `git rev-parse` prints `branch`; `git remote -v` prints `remotes`. */
function git(branch: string, remotes: string): void {
  execCli.mockImplementation(async (_bin: string, _cwd: string, args: string[]) =>
    args[0] === 'rev-parse' ? ok(branch) : ok(remotes)
  )
}

afterEach(() => execCli.mockReset())

describe('parseGitHubRemote', () => {
  it.each([
    'https://github.com/acme/repo.git',
    'https://github.com/acme/repo',
    'https://github.com/acme/repo/',
    'https://x-access-token:tok@github.com/acme/repo.git',
    'git@github.com:acme/repo.git',
    'ssh://git@github.com/acme/repo.git'
  ])('reads the owner and repository from %s', (url) => {
    expect(parseGitHubRemote(url)).toEqual({ owner: 'acme', repo: 'repo' })
  })

  it.each([
    'https://gitlab.com/acme/repo.git',
    'git@bitbucket.org:acme/repo.git',
    'https://github.com/acme',
    'https://github.com/acme/repo/extra',
    'https://github.com/../repo.git',
    'https://github.com/acme/..',
    'https://github.com/ac me/repo',
    '/srv/git/repo.git',
    ''
  ])('has no repository in %s', (url) => {
    expect(parseGitHubRemote(url)).toBeNull()
  })

  it('keeps the dots, dashes and underscores GitHub allows in names', () => {
    expect(parseGitHubRemote('git@github.com:my-org/my_repo.js.git')).toEqual({ owner: 'my-org', repo: 'my_repo.js' })
  })
})

describe('isSafeBranchName', () => {
  it('accepts ordinary branch names and refuses anything git could read as an option or a range', () => {
    expect(['main', 'feat/x', 'release-1.2', 'user/fix_thing'].every(isSafeBranchName)).toBe(true)
    expect(['', '-x', '--output=/tmp/x', 'a..b', 'a b', '/etc', 'a;b', 'a:b', '+main', 'main:other'].some(isSafeBranchName)).toBe(false)
  })
})

describe('repoRef', () => {
  it('takes the branch and the origin repository', async () => {
    git('feat/x\n', 'origin\thttps://github.com/acme/repo.git (fetch)\norigin\thttps://github.com/acme/repo.git (push)\n')
    await expect(repoRef('/repo')).resolves.toEqual({ owner: 'acme', repo: 'repo', headOwner: 'acme', branch: 'feat/x' })
  })

  it('uses the only remote when it is not called origin', async () => {
    git('main\n', 'github\tgit@github.com:acme/repo.git (fetch)\n')
    await expect(repoRef('/repo')).resolves.toMatchObject({ owner: 'acme', repo: 'repo', branch: 'main' })
  })

  it('sends pull requests to the upstream repository of a fork', async () => {
    git('feat/x\n', 'origin\thttps://github.com/me/repo.git (fetch)\nupstream\thttps://github.com/acme/repo.git (fetch)\n')
    await expect(repoRef('/repo')).resolves.toEqual({ owner: 'acme', repo: 'repo', headOwner: 'me', branch: 'feat/x' })
  })

  it('reports no branch on a detached HEAD', async () => {
    git('HEAD\n', 'origin\thttps://github.com/acme/repo.git (fetch)\n')
    await expect(repoRef('/repo')).resolves.toMatchObject({ branch: '' })
  })

  it('is unavailable without a github.com remote', async () => {
    git('main\n', 'origin\thttps://gitlab.com/acme/repo.git (fetch)\n')
    await expect(repoRef('/repo')).rejects.toBeInstanceOf(GitHubUnavailable)
    git('main\n', '')
    await expect(repoRef('/repo')).rejects.toBeInstanceOf(GitHubUnavailable)
  })
})
