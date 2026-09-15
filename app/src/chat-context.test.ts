import { describe, expect, it } from 'vitest'
import { emptyTerm } from './ansi'
import { agentPaneFor, chatOwnerFor, chatTabFor } from './chat-context'
import { leaf } from './layout'
import type { AgentPane, Tab } from './types'

function shell(id: string, branch?: string): Tab {
  const paneId = `pane:${id}`
  return {
    id,
    kind: 'shell',
    title: branch ?? 'zsh',
    status: null,
    branch,
    root: leaf(paneId),
    focus: paneId,
    panes: { [paneId]: { id: paneId, kind: 'shell', title: 'zsh', cwd: `/repo/${id}` } }
  }
}

function chat(ownerTabId: string): Tab {
  const pane: AgentPane = {
    id: `pane:agent:${ownerTabId}`,
    kind: 'agent',
    title: 'Chat',
    cwd: `/repo/${ownerTabId}`,
    taskId: `agent:${ownerTabId}`,
    status: 'working',
    attempt: 1,
    provider: 'claude',
    mode: 'build',
    messages: []
  }
  return {
    id: pane.taskId,
    kind: 'agent',
    ownerTabId,
    title: 'Chat',
    status: null,
    root: leaf(pane.id),
    focus: pane.id,
    panes: { [pane.id]: pane }
  }
}

describe('chat worktree context', () => {
  it('selects the chat owned by the active shell tab', () => {
    const tabs = [shell('main'), shell('feature', 'feat/x'), chat('main'), chat('feature')]
    const owner = chatOwnerFor(tabs, 'feature')
    const pane = agentPaneFor(chatTabFor(tabs, owner?.id))

    expect(owner?.id).toBe('feature')
    expect(pane?.taskId).toBe('agent:feature')
  })

  it('maps a pipeline run back to the shell on the same branch', () => {
    const tabs = [shell('main'), shell('feature', 'feat/x')]
    const run: Tab = {
      id: 'run:test:feat/x',
      kind: 'run',
      title: 'Test',
      status: 'running',
      branch: 'feat/x',
      root: leaf('run-pane'),
      focus: 'run-pane',
      panes: {
        'run-pane': {
          id: 'run-pane',
          kind: 'run',
          title: 'Test',
          cwd: '/repo/feature',
          term: emptyTerm()
        }
      }
    }

    expect(chatOwnerFor([...tabs, run], run.id)?.id).toBe('feature')
  })
})
