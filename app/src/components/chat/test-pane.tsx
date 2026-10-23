import { createElement, type ComponentProps } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { vi } from 'vitest'
import ChatPane from '../ChatPane'
import type { AgentPane } from '../../types'

export const chatPaneNoop = {
  onRefreshUsage: vi.fn(),
  onMessage: vi.fn(),
  onAnswer: vi.fn(),
  onCancel: vi.fn(),
  onProviderChange: vi.fn(),
  onModeChange: vi.fn(),
  onExecutePlan: vi.fn(),
  onAutoApproveChange: vi.fn(),
  onApprove: vi.fn(),
  onOpenPipeline: vi.fn(),
  onNewChat: vi.fn()
}

export function makeAgentPane(overrides: Partial<AgentPane> = {}): AgentPane {
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

export function renderChatPane(props: Partial<ComponentProps<typeof ChatPane>> = {}): string {
  return renderToStaticMarkup(
    createElement(ChatPane, {
      pane: makeAgentPane(),
      pipelines: [],
      projectPath: '/Users/dev/repo',
      defaultProvider: 'claude',
      usage: [],
      autoApprove: true,
      ...chatPaneNoop,
      ...props
    })
  )
}
