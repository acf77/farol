/**
 * @vitest-environment jsdom
 */
import { describe, expect, it, vi } from 'vitest'
import { makeAgentPane, renderChatPane } from './chat/test-pane'
import type { AgentPane } from '../types'

describe('ChatPane clear-chat overlay', () => {
  it('stays out of the DOM until a clear is requested', () => {
    const html = renderChatPane()
    expect(html).not.toContain('Clear this conversation?')
  })

  it('renders an attention-drawing, modal overlay with an explicit confirmation', () => {
    const html = renderChatPane({ clearChatConfirm: true })
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
    const html = renderChatPane({ pane: makeAgentPane({ messages }), onFreshStart: vi.fn() })
    expect(html).not.toContain('ctx ')
    expect(html).not.toContain('Fresh start')
  })

  it('shows a quiet reading below the warning level', () => {
    const html = renderChatPane({
      pane: makeAgentPane({ messages, usage: { tokens: 60_000, window: 200_000 } }),
      onFreshStart: vi.fn()
    })
    expect(html).toContain('ctx 30%')
    expect(html).not.toContain('Fresh start')
  })

  it('recommends a fresh start once the context is large', () => {
    const html = renderChatPane({
      pane: makeAgentPane({ messages, usage: { tokens: 150_000, window: 200_000 } }),
      onFreshStart: vi.fn()
    })
    expect(html).toContain('ctx 75% !')
    expect(html).toContain('Context is large (150k of 200k tokens).')
    expect(html).toContain('Fresh start')
  })

  it('recommends a fresh start after the agent runs out of context', () => {
    const html = renderChatPane({
      pane: makeAgentPane({
        messages: [...messages, { role: 'system', text: 'Agent stopped: context length exceeded' }]
      }),
      onFreshStart: vi.fn()
    })
    expect(html).toContain('The agent ran out of context.')
  })
})
