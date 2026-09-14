import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { ChatModeSwitch } from './components/ChatPane'

describe('ChatModeSwitch', () => {
  it('shows Plan and Build and selects Build by default', () => {
    const html = renderToStaticMarkup(
      createElement(ChatModeSwitch, {
        mode: 'build',
        provider: 'codex',
        locked: false,
        onChange: vi.fn()
      })
    )
    expect(html).toContain('>Plan<')
    expect(html).toContain('>Build<')
    expect(html).toMatch(/aria-pressed="false"[^>]*>Plan</)
    expect(html).toMatch(/aria-pressed="true"[^>]*>Build</)
  })

  it('disables Plan with the provider-specific reason when no review gate exists', () => {
    const html = renderToStaticMarkup(
      createElement(ChatModeSwitch, {
        mode: 'build',
        provider: 'claude',
        locked: false,
        onChange: vi.fn()
      })
    )
    expect(html).toContain('title="Claude: Cannot enforce read-only"')
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Plan<\/button>/)
  })

  it('locks both sides while the agent is working', () => {
    const html = renderToStaticMarkup(
      createElement(ChatModeSwitch, {
        mode: 'plan',
        provider: 'cursor',
        locked: true,
        onChange: vi.fn()
      })
    )
    expect(html.match(/disabled=""/g)).toHaveLength(2)
  })
})
