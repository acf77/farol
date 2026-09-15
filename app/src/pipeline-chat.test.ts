import { describe, expect, it } from 'vitest'
import type { RunEvent, RunOrigin } from '@shared/types'
import { agentPaneFor } from './chat-context'
import { leaf } from './layout'
import { pipelineActivityText, projectRunChat } from './pipeline-chat'
import type { Tab } from './types'

function chat(id: string, branch = 'main'): Tab {
  return {
    id, branch, kind: 'agent', title: 'Chat', status: null,
    root: leaf(id), focus: id,
    panes: {
      [id]: {
        id, kind: 'agent', title: 'Chat', cwd: '/repo', taskId: id,
        status: 'idle', attempt: 0, provider: 'openrouter', mode: 'build', messages: []
      }
    }
  }
}

function start(origin: RunOrigin, runId = 'run-1'): Extract<RunEvent, { kind: 'start' }> {
  return {
    kind: 'start', origin, runId, pipelineId: 'runtime:lint', branch: 'main',
    steps: 2, cwd: '/repo', startedAt: 1000
  }
}

describe('shared pipeline chat activity', () => {
  it.each<RunOrigin>(['app', 'agent', 'managed-agent'])(
    'shows and completes the same card for %s in every chat on the run branch', (origin) => {
      const event = start(origin)
      const tabs = [chat('a'), chat('b'), chat('other', 'feature')]
      const running = projectRunChat(tabs, event, 'lint', 'Lint')
      for (const tab of running.slice(0, 2)) {
        expect(agentPaneFor(tab)?.messages[0].pipeline).toMatchObject({
          runId: 'run-1', status: 'running', tabId: 'run:lint:main'
        })
        expect(agentPaneFor(tab)?.messages[0].text).toMatch(/^\$ pipeline run — started /)
      }
      expect(running[2]).toBe(tabs[2])
      const completed = projectRunChat(running, { ...event, kind: 'end', ok: true }, 'lint', 'Lint')
      expect(agentPaneFor(completed[0])?.messages).toHaveLength(1)
      expect(agentPaneFor(completed[0])?.messages[0].pipeline?.status).toBe('passed')
      expect(agentPaneFor(completed[0])?.messages[0].text).toMatch(/^passed — /)
    }
  )

  it('keeps overlapping runs separate and settles the correct card after switching branches', () => {
    const first = start('app')
    const second = start('managed-agent', 'run-2')
    let tabs = projectRunChat([chat('a')], first, 'lint', 'Lint')
    tabs = projectRunChat(tabs, second, 'lint', 'Lint')
    tabs = tabs.map((tab) => ({ ...tab, branch: 'feature' }))
    tabs = projectRunChat(tabs, { ...first, kind: 'end', ok: false, cancelled: true }, 'lint', 'Lint')
    expect(agentPaneFor(tabs[0])?.messages.map((m) => m.pipeline?.status)).toEqual(['cancelled', 'running'])
    tabs = projectRunChat(tabs, { ...second, kind: 'end', ok: false }, 'lint', 'Lint')
    expect(agentPaneFor(tabs[0])?.messages.map((m) => m.pipeline?.status)).toEqual(['cancelled', 'failed'])
  })

  it('uses the same activity line for running and finished cards', () => {
    expect(pipelineActivityText({ status: 'running', startedAt: 1_700_000_000_000 })).toMatch(
      /^\$ pipeline run — started /
    )
    expect(pipelineActivityText({
      status: 'failed', startedAt: 1, finishedAt: 2500, durationMs: 2499
    })).toMatch(/^failed — .* · 2\.5s$/)
  })

  it('does not create chats as a side effect of a run', () => {
    const shell: Tab = {
      id: 'sh1', kind: 'shell', title: 'zsh', status: null, branch: 'main',
      root: leaf('sh1'), focus: 'sh1',
      panes: { sh1: { id: 'sh1', kind: 'shell', title: 'zsh', cwd: '/repo' } }
    }
    expect(projectRunChat([shell], start('app'), 'lint', 'Lint')[0]).toBe(shell)
  })

  it('does not duplicate starts or recreate cards after a chat is cleared', () => {
    const event = start('app')
    let tabs = projectRunChat([chat('a')], event, 'lint', 'Lint')
    tabs = projectRunChat(tabs, event, 'lint', 'Lint')
    expect(agentPaneFor(tabs[0])?.messages).toHaveLength(1)
    const cleared = [chat('a')]
    expect(projectRunChat(cleared, { ...event, kind: 'end', ok: true }, 'lint', 'Lint')[0]).toBe(cleared[0])
  })
})
