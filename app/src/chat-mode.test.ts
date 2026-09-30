import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { normalizeMode } from '@shared/ai'
import { sanitizeSession } from '@shared/session'
import { modeDefault, sanitizeSettings } from '@shared/settings'
import { ChatModeSwitch } from './components/chat/Composer'
import { makeAgentPane, renderChatPane } from './components/chat/test-pane'
import type { AgentPane } from './types'

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

function renderChat(pane: AgentPane | null): string {
  const settings = sanitizeSettings({
    agent: 'claude',
    models: { claude: 'opus' },
    modeDefaults: { build: [{ agent: 'cursor', model: 'composer-2.5' }] }
  })
  const choice = modeDefault(settings, 'build')
  return renderChatPane({
    pane,
    projectPath: '/repo',
    defaultProvider: choice.agent,
    defaultModel: choice.model,
    settings
  })
}

describe('restored chat model selection', () => {
  it.each([
    { provider: 'cursor' as const, model: undefined, label: 'Cursor · Auto' },
    { provider: 'cursor' as const, model: 'auto', label: 'Cursor · Auto' },
    { provider: 'codex' as const, model: undefined, label: 'Codex' },
    { provider: 'codex' as const, model: 'custom-model', label: 'Codex · custom-model' }
  ])('keeps $provider / $model instead of inheriting the settings model', ({ provider, model, label }) => {
    const pane = makeAgentPane({
      id: 'agent-pane',
      cwd: '/repo',
      taskId: 'agent:sh1',
      attempt: 0,
      provider,
      model,
      messages: []
    })
    const session = sanitizeSession(JSON.parse(JSON.stringify({
      activeTab: 'sh1',
      tabs: [
        {
          id: 'sh1',
          title: 'zsh',
          focus: 'shell-pane',
          root: { t: 'leaf', id: 'shell-pane' },
          panes: [{ id: 'shell-pane', title: 'zsh', cwd: '/repo' }]
        },
        {
          id: 'agent:sh1',
          kind: 'agent',
          ownerTabId: 'sh1',
          title: 'Chat',
          focus: pane.id,
          root: { t: 'leaf', id: pane.id },
          panes: [pane]
        }
      ]
    })))
    const saved = session?.tabs[1].panes[0]
    expect(saved?.kind).toBe('agent')
    if (saved?.kind !== 'agent') throw new Error('Missing saved chat')
    const restored: AgentPane = {
      ...saved,
      status: 'idle',
      mode: normalizeMode(saved.mode)
    }
    expect(restored.model).toBe(model)
    expect(renderChat(restored)).toContain(`title="Agent: ${label}"`)
  })

  it('uses the configured Build model when no chat has been saved', () => {
    expect(renderChat(null)).toContain('title="Agent: Cursor · Composer 2.5"')
  })
})

describe('ChatModeSwitch', () => {
  it('shows Plan and Build and selects Build by default', () => {
    const html = renderToStaticMarkup(
      createElement(ChatModeSwitch, {
        mode: 'build',
        locked: false,
        onChange: vi.fn()
      })
    )
    expect(html).toContain('>Plan<')
    expect(html).toContain('>Build<')
    expect(html).toMatch(/aria-pressed="false"[^>]*>Plan</)
    expect(html).toMatch(/aria-pressed="true"[^>]*>Build</)
  })

  it('locks both sides while the agent is working', () => {
    const html = renderToStaticMarkup(
      createElement(ChatModeSwitch, {
        mode: 'plan',
        locked: true,
        onChange: vi.fn()
      })
    )
    expect(html.match(/disabled=""/g)).toHaveLength(2)
  })
})

describe('Execute plan handoff', () => {
  it('shows Execute plan under a finished, unconsumed plan message', () => {
    expect(
      renderChat(
        makeAgentPane({
          id: 'agent-pane',
          cwd: '/repo',
          taskId: 'agent:sh1',
          attempt: 0,
          provider: 'codex',
          mode: 'plan',
          messages: [
            {
              role: 'assistant',
              text: '## Plan\n\n1. Do the work.',
              plan: { finished: true }
            }
          ]
        })
      )
    ).toContain('Execute plan')
  })

  it('hides Execute plan once the finished plan is consumed', () => {
    expect(
      renderChat(
        makeAgentPane({
          id: 'agent-pane',
          cwd: '/repo',
          taskId: 'agent:sh1',
          attempt: 0,
          provider: 'codex',
          mode: 'build',
          messages: [
            {
              role: 'assistant',
              text: '## Plan\n\n1. Do the work.',
              plan: { finished: true, consumed: true }
            }
          ]
        })
      )
    ).not.toContain('Execute plan')
  })
})
