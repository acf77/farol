/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { ApprovalCard, ToolCard } from './cards'
import { AutoApproveChip } from './Composer'
import { applyApprovalEvent } from '../../approval-chat'

afterEach(cleanup)

const ask = { requestId: 'r1', provider: 'claude' as const, toolName: 'Bash', detail: 'npm test' }

describe('ApprovalCard', () => {
  it('asks with the command and answers each way', () => {
    const onDecide = vi.fn()
    render(<ApprovalCard card={ask} onDecide={onDecide} />)
    expect(screen.getByText('Claude asks to run Bash')).toBeTruthy()
    expect(screen.getByText('npm test')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Allow once' }))
    fireEvent.click(screen.getByRole('button', { name: 'Allow Bash for this chat' }))
    fireEvent.click(screen.getByRole('button', { name: 'Deny' }))
    expect(onDecide.mock.calls).toEqual([['once'], ['chat'], ['deny']])
  })

  it('shrinks to one line once answered', () => {
    render(<ApprovalCard card={{ ...ask, decision: 'deny' }} onDecide={vi.fn()} />)
    expect(screen.getByText('Declined')).toBeTruthy()
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('names a subagent that asks', () => {
    render(<ApprovalCard card={{ ...ask, provider: 'claude', delegateId: 't:d1' }} onDecide={vi.fn()} />)
    expect(screen.getByText('Claude subagent asks to run Bash')).toBeTruthy()
  })
})

describe('applyApprovalEvent', () => {
  it('updates the request in place when answered', () => {
    const event = { kind: 'approval' as const, taskId: 't', ...ask }
    let messages = applyApprovalEvent([], event)
    messages = applyApprovalEvent(messages, { ...event, decision: 'once' })
    expect(messages).toHaveLength(1)
    expect(messages[0].approval?.decision).toBe('once')
    expect(messages[0].text).toBe('Allowed once: Bash — npm test')
  })
})

describe('AutoApproveChip', () => {
  it('shows on, and turns off for Claude', () => {
    const onChange = vi.fn()
    render(<AutoApproveChip on provider="claude" mode="build" onChange={onChange} />)
    const chip = screen.getByRole('button', { name: 'Auto-approve' })
    expect(chip.getAttribute('aria-pressed')).toBe('true')
    fireEvent.click(chip)
    expect(onChange).toHaveBeenCalledWith(false)
  })

  it('reads "Ask first" when off', () => {
    render(<AutoApproveChip on={false} provider="claude" mode="build" onChange={vi.fn()} />)
    expect(screen.getByRole('button', { name: 'Ask first' }).getAttribute('aria-pressed')).toBe('false')
  })

  it('stays on and disabled for a CLI that cannot ask, naming it', () => {
    render(<AutoApproveChip on={false} provider="codex" mode="build" onChange={vi.fn()} />)
    const chip = screen.getByRole('button', { name: 'Auto-approve' }) as HTMLButtonElement
    expect(chip.disabled).toBe(true)
    expect(chip.title).toBe('Codex: Cannot ask for approval')
  })

  it('is hidden in Plan', () => {
    const { container } = render(<AutoApproveChip on provider="claude" mode="plan" onChange={vi.fn()} />)
    expect(container.textContent).toBe('')
  })
})

describe('ToolCard auto marker', () => {
  it('marks a call that ran without asking', () => {
    render(<ToolCard tool={{ toolId: 'w', name: 'Write', detail: 'a.txt', state: 'done', auto: true }} tight={false} />)
    expect(screen.getByText('auto').getAttribute('title')).toBe('Ran without asking, because auto-approve is on')
  })
})
