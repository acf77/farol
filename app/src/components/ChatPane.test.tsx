/**
 * @vitest-environment jsdom
 */
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import ChatPane from './ChatPane'
import type { AgentPane } from '../types'

const noop = {
  onRefreshUsage: vi.fn(),
  onMessage: vi.fn(),
  onAnswer: vi.fn(),
  onCancel: vi.fn(),
  onProviderChange: vi.fn(),
  onModeChange: vi.fn(),
  onExecutePlan: vi.fn(),
  onOpenPipeline: vi.fn(),
  onNewChat: vi.fn()
}

function makePane(overrides: Partial<AgentPane> = {}): AgentPane {
  return {
    id: 'pane-1',
    title: 'Chat',
    cwd: '/Users/dev/repo',
    kind: 'agent',
    taskId: 'task-1',
    status: 'idle',
    attempt: 1,
    provider: 'claude',
    mode: 'build',
    messages: [],
    ...overrides
  }
}

function renderPane(props: Partial<Parameters<typeof ChatPane>[0]> = {}): string {
  return renderToStaticMarkup(
    <ChatPane
      pane={makePane()}
      pipelines={[]}
      view="chat"
      projectPath="/Users/dev/repo"
      defaultProvider="claude"
      usage={[]}
      {...noop}
      {...props}
    />
  )
}

describe('ChatPane clear-chat overlay', () => {
  it('stays out of the DOM until a clear is requested', () => {
    const html = renderPane()
    expect(html).not.toContain('Clear this conversation?')
  })

  it('renders an attention-drawing, modal overlay with an explicit confirmation', () => {
    const html = renderPane({ clearChatConfirm: true })
    expect(html).toContain('role="alertdialog"')
    expect(html).toContain('aria-modal="true"')
    expect(html).toContain('Clear this conversation?')
    expect(html).toContain("permanently deletes")
    expect(html).toContain('Clear chat')
    expect(html).toContain('Cancel')
  })
})

describe('ChatPane context meter and fresh start', () => {
  const messages: AgentPane['messages'] = [{ role: 'user', text: 'Fix it' }]

  it('shows nothing without a reading from the CLI', () => {
    const html = renderPane({ pane: makePane({ messages }), onFreshStart: vi.fn() })
    expect(html).not.toContain('ctx ')
    expect(html).not.toContain('Fresh start')
  })

  it('shows a quiet reading below the warning level', () => {
    const html = renderPane({
      pane: makePane({ messages, usage: { tokens: 60_000, window: 200_000 } }),
      onFreshStart: vi.fn()
    })
    expect(html).toContain('ctx 30%')
    expect(html).not.toContain('Fresh start')
  })

  it('recommends a fresh start once the context is large', () => {
    const html = renderPane({
      pane: makePane({ messages, usage: { tokens: 150_000, window: 200_000 } }),
      onFreshStart: vi.fn()
    })
    expect(html).toContain('ctx 75% !')
    expect(html).toContain('Context is large (150k of 200k tokens).')
    expect(html).toContain('Fresh start')
  })

  it('recommends a fresh start after the agent runs out of context', () => {
    const html = renderPane({
      pane: makePane({
        messages: [...messages, { role: 'system', text: 'Agent stopped: context length exceeded' }]
      }),
      onFreshStart: vi.fn()
    })
    expect(html).toContain('The agent ran out of context.')
  })
})
