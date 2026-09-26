import { createElement, type ComponentProps } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Todo } from '@shared/todos'
import { TodoDockView } from './components/TodoList'
import { makeAgentPane, renderChatPane } from './components/chat/test-pane'
import { modeDefault, sanitizeSettings } from '@shared/settings'

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

const sample: Todo[] = [
  { content: 'Ship the dock', status: 'completed', priority: 'high' },
  { content: 'Wire persistence', status: 'in_progress', priority: 'high' },
  { content: 'Write tests', status: 'pending', priority: 'medium' },
  { content: 'Old idea', status: 'cancelled', priority: 'low' }
]

const noop = {
  onToggle: vi.fn(),
  onDismiss: vi.fn(),
  onRetry: vi.fn(),
  onRun: vi.fn(),
  onEdit: vi.fn(),
  onCancelEdit: vi.fn(),
  onSave: vi.fn().mockResolvedValue(undefined)
}

function renderDock(props: Partial<ComponentProps<typeof TodoDockView>> = {}): string {
  return renderToStaticMarkup(
    createElement(TodoDockView, {
      todos: sample,
      error: null,
      open: false,
      editing: null,
      saving: false,
      canRun: true,
      ...noop,
      ...props
    })
  )
}

describe('TodoDockView', () => {
  it('shows completed/total progress and the active preview when collapsed', () => {
    const html = renderDock()
    expect(html).toContain('bf-todo-dock')
    expect(html).toContain('1 of 4 todos completed')
    expect(html).toContain('bf-todo-dock-preview')
    expect(html).toContain('Wire persistence')
    expect(html).toContain('aria-expanded="false"')
    expect(html).toContain('hidden')
  })

  it('expands into a checklist with accessible status labels and strikethrough for done work', () => {
    const html = renderDock({ open: true })
    expect(html).toContain('aria-expanded="true"')
    expect(html).toContain('Shared by every chat in this checkout')
    expect(html).toContain('data-status="completed"')
    expect(html).toContain('data-status="in_progress"')
    expect(html).toContain('data-status="pending"')
    expect(html).toContain('data-status="cancelled"')
    expect(html).toContain('bf-todo-text is-done')
    expect(html).toContain('In progress')
    expect(html).toContain('Completed')
    expect(html).toContain('Cancelled')
    expect(html).toContain('Pending')
  })

  it('keeps empty, loading, and unavailable headers reachable', () => {
    expect(renderDock({ todos: [] })).toContain('No todos')
    expect(renderDock({ todos: null })).toContain('Loading…')
    expect(renderDock({ todos: null, error: 'offline' })).toContain('Unavailable')
    expect(renderDock({ todos: null, error: 'offline', open: true })).toContain('Retry')
  })
})

describe('ChatPane todo placement', () => {
  it('mounts the todo dock above the composer', () => {
    vi.stubGlobal('farol', {
      todos: {
        load: vi.fn().mockResolvedValue({ checkout: '/repo', todos: sample }),
        save: vi.fn().mockResolvedValue(undefined),
        onChanged: vi.fn().mockReturnValue(() => {})
      }
    })
    const settings = sanitizeSettings({
      agent: 'codex',
      models: { codex: 'gpt-5.6-sol' },
      modeDefaults: { build: [{ agent: 'codex' }] }
    })
    const choice = modeDefault(settings, 'build')
    const html = renderChatPane({
      pane: makeAgentPane({
        id: 'agent-pane',
        cwd: '/repo',
        taskId: 'agent:sh1',
        attempt: 0,
        provider: 'codex',
        model: choice.model
      }),
      projectPath: '/repo',
      defaultProvider: choice.agent,
      defaultModel: choice.model,
      settings
    })

    const dock = html.indexOf('bf-todo-dock')
    const composer = html.indexOf('Message the agent')
    expect(dock).toBeGreaterThan(-1)
    expect(composer).toBeGreaterThan(dock)
  })
})
