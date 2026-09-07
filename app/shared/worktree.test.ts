import { describe, expect, it } from 'vitest'
import {
  branchNameError,
  parseAlreadyOpenPath,
  parseWorktreeList,
  pipelineStoreRoot,
  worktreeFolderName
} from './worktree'

describe('parseWorktreeList', () => {
  it('reads porcelain worktrees', () => {
    const raw = [
      'worktree /repos/app',
      'HEAD abc',
      'branch refs/heads/main',
      '',
      'worktree /repos/app-feature-x',
      'HEAD def',
      'branch refs/heads/feature/x',
      '',
      'worktree /repos/app-detached',
      'HEAD ghi',
      'detached',
      ''
    ].join('\n')
    expect(parseWorktreeList(raw)).toEqual([
      { path: '/repos/app', branch: 'main' },
      { path: '/repos/app-feature-x', branch: 'feature/x' },
      { path: '/repos/app-detached', branch: null }
    ])
  })
})

describe('pipelineStoreRoot', () => {
  const trees = parseWorktreeList(
    ['worktree /repos/app', 'branch refs/heads/main', '', 'worktree /repos/app-feature', 'branch refs/heads/feature/x', ''].join(
      '\n'
    )
  )

  it('uses the primary worktree for linked checkouts', () => {
    expect(pipelineStoreRoot('/repos/app-feature', trees)).toBe('/repos/app')
  })

  it('falls back to the main checkout via git-common-dir', () => {
    expect(pipelineStoreRoot('/repos/app-feature', [], '/repos/app/.git')).toBe('/repos/app')
  })

  it('keeps a non-repo path as-is', () => {
    expect(pipelineStoreRoot('/tmp/sandbox', [], null)).toBe('/tmp/sandbox')
  })
})

describe('parseAlreadyOpenPath', () => {
  it('pulls the folder out of git checkout/worktree errors', () => {
    expect(
      parseAlreadyOpenPath(
        "fatal: 'feat/x' is already checked out at '/repos/app-feat-x'"
      )
    ).toBe('/repos/app-feat-x')
    expect(
      parseAlreadyOpenPath("fatal: 'feat/x' is already used by worktree at '/repos/app-feat-x'")
    ).toBe('/repos/app-feat-x')
  })
})

describe('worktreeFolderName', () => {
  it('turns slashes into dashes so the folder is a sibling of the repo', () => {
    expect(worktreeFolderName('allaboard365', 'feature/quote')).toBe('allaboard365-feature-quote')
  })

  it('prefers a name the user typed', () => {
    expect(worktreeFolderName('allaboard365', 'feature/quote', 'quote-wip')).toBe('quote-wip')
  })

  it('keeps a custom name to one folder deep', () => {
    expect(worktreeFolderName('app', 'x', '../../etc/passwd')).toBe('etc-passwd')
    expect(worktreeFolderName('app', 'x', 'a/b')).toBe('a-b')
  })

  it('falls back to the branch when the custom name sanitises away', () => {
    expect(worktreeFolderName('app', 'ci/lint', '   ')).toBe('app-ci-lint')
    expect(worktreeFolderName('app', 'ci/lint', '...')).toBe('app-ci-lint')
  })
})

describe('branchNameError', () => {
  it('accepts the shapes people actually use', () => {
    for (const ok of ['ci/lint', 'feature/JIRA-12_thing', 'v2.1-rc', 'fix']) {
      expect(branchNameError(ok)).toBeNull()
    }
  })

  it('explains what git would reject', () => {
    expect(branchNameError('')).toBe('Enter a branch name')
    expect(branchNameError('my branch')).toBe('No spaces')
    expect(branchNameError('feat~1')).toBe('No ~ ^ : ? * [ or backslash')
    expect(branchNameError('-x')).toBe('Cannot start with - or .')
    expect(branchNameError('a//b')).toBe('Misplaced /')
    expect(branchNameError('x.lock')).toBe('Cannot end with . or .lock')
    expect(branchNameError('a..b')).toBe('No .. or @{')
    expect(branchNameError('@')).toBe('@ is reserved')
  })
})
