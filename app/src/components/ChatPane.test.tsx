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
