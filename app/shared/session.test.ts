import { describe, expect, it } from 'vitest'
import { closedProjects, sanitizeOpenProjects, sanitizeSession, sessionSeq } from './session'

const splitTab = {
  id: 'sh2',
  title: 'zsh',
  branch: 'feat/x',
  focus: 'p1_abc',
  root: {
    t: 'split' as const,
    id: 's1',
    dir: 'row' as const,
    size: 40,
    a: { t: 'leaf' as const, id: 'p1_abc' },
    b: { t: 'leaf' as const, id: 'p2_def' }
  },
  panes: [
    { id: 'p1_abc', title: 'zsh', cwd: '/repo' },
    { id: 'p2_def', title: 'zsh', cwd: '/repo/app' }
  ]
}

describe('sanitizeSession', () => {
  it('keeps a split tab and clamps the divider', () => {
    const s = sanitizeSession({
      sidebarW: 320,
      selId: 'lint',
      activeTab: 'sh2',
      tabs: [{ ...splitTab, root: { ...splitTab.root, size: 99 } }]
    })
    expect(s?.activeTab).toBe('sh2')
    expect(s?.tabs[0].branch).toBe('feat/x')
    expect(s?.tabs[0].root.t === 'split' && s.tabs[0].root.size).toBe(85)
  })

  it('drops a tab whose tree is missing a pane', () => {
    const s = sanitizeSession({
      tabs: [{ ...splitTab, panes: [splitTab.panes[0]] }]
    })
    expect(s).toBeNull()
  })

  it('keeps an agent chat linked to its worktree tab', () => {
    const s = sanitizeSession({
      activeTab: 'sh2',
      tabs: [
        splitTab,
        {
          id: 'agent:sh2',
          kind: 'agent',
          ownerTabId: 'sh2',
          title: 'Chat',
          focus: 'agent-pane',
          root: { t: 'leaf', id: 'agent-pane' },
          panes: [
            {
              id: 'agent-pane',
              kind: 'agent',
              title: 'Chat',
              cwd: '/repo',
              taskId: 'agent:sh2',
              status: 'working',
              attempt: 1,
              provider: 'claude',
              mode: 'plan',
              model: 'sonnet',
              messages: [{ role: 'assistant', text: 'Plan\nFAROL_PLAN: finished', plan: { finished: true } }]
            }
          ]
        }
      ]
    })

    expect(s?.tabs[1].ownerTabId).toBe('sh2')
    expect(s?.tabs[1].panes[0]).toMatchObject({ kind: 'agent', provider: 'claude', mode: 'plan', model: 'sonnet' })
    expect((s?.tabs[1].panes[0] as { messages?: unknown[] }).messages?.[0]).toMatchObject({
      plan: { finished: true }
    })
  })
})

describe('sessionSeq', () => {
  it('walks tab, pane, and split ids so new ones do not collide', () => {
    expect(sessionSeq([splitTab])).toEqual({ shell: 2, pane: 2, split: 1 })
  })
})

describe('closedProjects', () => {
  it('returns paths that left the workspace, ignoring trailing slashes', () => {
    expect(closedProjects(['/a', '/b/'], ['/b', '/c'])).toEqual(['/a'])
  })
})

describe('sanitizeOpenProjects', () => {
  it('migrates the legacy last project into the repository list', () => {
    expect(sanitizeOpenProjects(undefined, undefined, '/repos/one')).toEqual({
      openProjects: ['/repos/one'],
      activeProject: '/repos/one'
    })
  })

  it('keeps unique repositories and falls back to an open active repository', () => {
    expect(
      sanitizeOpenProjects(['/repos/one', '/repos/two', '/repos/one'], '/repos/missing', null)
    ).toEqual({
      openProjects: ['/repos/one', '/repos/two'],
      activeProject: '/repos/one'
    })
  })
})
