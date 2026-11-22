import { describe, expect, it } from 'vitest'
import { GIT_MARKER, isControlLine, stripControlMarkerLines } from './control-line'
import { formatGitResult, formatGitStatus, gitActionsFrom, parseGitAction } from './git-action'
import type { GitStatus } from './types'

describe('parseGitAction', () => {
  it('reads each action', () => {
    expect(parseGitAction({ action: 'status' })).toEqual({ action: 'status' })
    expect(parseGitAction({ action: 'push', extra: 1 })).toEqual({ action: 'push' })
    expect(parseGitAction({ action: 'commit', message: '  feat: x  ', files: ['a.ts', 3, 'b.ts'] })).toEqual({
      action: 'commit',
      message: 'feat: x',
      files: ['a.ts', 'b.ts']
    })
    expect(parseGitAction({ action: 'create_pr', title: 'T', body: ' ', base: 'main' })).toEqual({
      action: 'create_pr',
      title: 'T',
      base: 'main'
    })
    expect(parseGitAction({ action: 'create_pr' })).toEqual({ action: 'create_pr' })
  })

  it('says what is wrong with a request it cannot use', () => {
    expect(parseGitAction({ action: 'commit', message: '  ' })).toEqual({ error: 'A commit needs a non-empty "message".' })
    expect(parseGitAction({ action: 'reset' })).toMatchObject({ error: expect.stringContaining('Unknown Git action "reset"') })
    expect(parseGitAction(['commit'])).toMatchObject({ error: expect.stringContaining('one JSON object') })
    expect(parseGitAction(null)).toMatchObject({ error: expect.stringContaining('one JSON object') })
  })
})

describe('gitActionsFrom', () => {
  it('takes every FAROL_GIT line in order and reports the ones it cannot read', () => {
    const control = [
      `${GIT_MARKER} {"action":"commit","message":"feat: add it"}`,
      'FAROL_TODOS: []',
      `${GIT_MARKER} {"action":"push"}`,
      `${GIT_MARKER} not json`,
      `${GIT_MARKER} {"action":"rebase"}`,
      'FAROL_PIPELINES: []'
    ].join('\n')
    const { actions, errors } = gitActionsFrom(control)
    expect(actions).toEqual([{ action: 'commit', message: 'feat: add it' }, { action: 'push' }])
    expect(errors).toHaveLength(2)
    expect(errors[0]).toContain(GIT_MARKER)
  })

  it('counts a line that repeats word for word once', () => {
    const line = `${GIT_MARKER} {"action":"commit","message":"feat: add it"}`
    expect(gitActionsFrom(`${line}\n${line}\n${GIT_MARKER} {"action":"push"}`).actions).toEqual([
      { action: 'commit', message: 'feat: add it' },
      { action: 'push' }
    ])
  })

  it('has nothing to do when the reply asks for nothing', () => {
    expect(gitActionsFrom('FAROL_PIPELINES: []')).toEqual({ actions: [], errors: [] })
  })

  it('ignores a request quoted in a code block', () => {
    const reply = ['Use this line:', '```', `${GIT_MARKER} {"action":"push"}`, '```'].join('\n')
    expect(gitActionsFrom(reply).actions).toEqual([])
  })
})

describe('FAROL_GIT as a control line', () => {
  it('is hidden from the visible message like the other control lines', () => {
    expect(isControlLine(`${GIT_MARKER} {"action":"push"}`)).toBe(true)
    expect(stripControlMarkerLines(`Done.\n${GIT_MARKER} {"action":"push"}\nFAROL_PIPELINES: []`)).toBe('Done.')
  })
})

describe('formatGitStatus', () => {
  const file = (path: string, kind: 'modified' | 'untracked', staged = false) => ({ path, kind, staged })
  const base: GitStatus = { clean: true, staged: [], unstaged: [], untracked: [], conflicts: [], ahead: 0, behind: 0, upstream: true }

  it('describes a clean branch that follows its remote', () => {
    expect(formatGitStatus('main', base)).toBe('Branch main: 0 ahead and 0 behind its remote branch.\nWorking tree is clean.')
  })

  it('lists each changed file once, and says when the branch is not published', () => {
    const text = formatGitStatus('feat/x', {
      ...base,
      clean: false,
      upstream: false,
      remote: 'origin',
      ahead: 1,
      staged: [file('a.ts', 'modified', true)],
      unstaged: [file('a.ts', 'modified')],
      untracked: [file('b.ts', 'untracked')]
    })
    expect(text).toBe(
      ['Branch feat/x: not published to origin (1 unpushed commit).', '2 changed files:', '  modified: a.ts', '  untracked: b.ts'].join('\n')
    )
  })

  it('names a repository with no remote and cuts a long list short', () => {
    const many = Array.from({ length: 45 }, (_, i) => file(`f${i}.ts`, 'modified'))
    const lines = formatGitStatus('main', { ...base, clean: false, upstream: false, unstaged: many }).split('\n')
    expect(lines[0]).toBe('Branch main: no remote.')
    expect(lines[1]).toBe('45 changed files:')
    expect(lines).toHaveLength(2 + 40 + 1)
    expect(lines.at(-1)).toBe('  …and 5 more')
  })
})

describe('formatGitResult', () => {
  it('says whether the action was done, refused, or failed', () => {
    expect(formatGitResult('push', { ok: true, message: 'Pushed' })).toBe('Git push done: Pushed')
    expect(formatGitResult('create_pr', { ok: false, message: 'No commits' })).toBe('Git pull request failed: No commits')
    expect(formatGitResult('commit', { ok: false, refused: true, message: 'Git actions are turned off.' })).toBe(
      'Git commit refused: Git actions are turned off.'
    )
  })

  it('adds the output of the hook that blocked it', () => {
    expect(
      formatGitResult('commit', { ok: false, message: 'Commit failed', hookRun: { hooks: ['pre-commit'], output: 'lint: 2 errors' } })
    ).toBe('Git commit failed: Commit failed\nBlocked by pre-commit. Its output:\nlint: 2 errors')
  })
})
