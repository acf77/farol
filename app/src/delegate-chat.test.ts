import { describe, expect, it } from 'vitest'
import type { AgentTaskEvent } from '@shared/types'
import { applyDelegateActivity, applyDelegateEvent, isDelegateActivity } from './delegate-chat'
import type { AgentMessage } from './types'

const start: Extract<AgentTaskEvent, { kind: 'delegate' }> = {
  kind: 'delegate',
  taskId: 't',
  delegateId: 't:d1',
  provider: 'codex',
  task: 'Add a test',
  state: 'running'
}

describe('delegate chat cards', () => {
  it('opens one card and closes it in place with the diff stat', () => {
    let messages: AgentMessage[] = [{ role: 'assistant', text: 'Handing off.' }]
    messages = applyDelegateEvent(messages, start)
    expect(messages).toHaveLength(2)
    expect(messages[1].delegate?.state).toBe('running')
    expect(messages[1].text).toContain('Codex subagent working: Add a test')

    messages = applyDelegateEvent(messages, { ...start, state: 'done', diffStat: ' a.ts | 2 +-' })
    expect(messages).toHaveLength(2)
    expect(messages[1].delegate?.state).toBe('done')
    expect(messages[1].text).toContain('a.ts | 2 +-')
  })

  it('folds the subagent’s tools and words into its card, not the transcript', () => {
    let messages = applyDelegateEvent([], start)
    const tool = { kind: 'tool', taskId: 't', delegateId: 't:d1', toolId: 't:d1:x', name: 'shell', detail: 'ls', state: 'running' } as const
    expect(isDelegateActivity(tool)).toBe(true)
    expect(isDelegateActivity({ kind: 'tool', taskId: 't', toolId: 'y', name: 'shell', state: 'done' })).toBe(false)

    messages = applyDelegateActivity(messages, tool)
    messages = applyDelegateActivity(messages, { ...tool, detail: undefined, state: 'done' })
    messages = applyDelegateActivity(messages, { kind: 'output', taskId: 't', delegateId: 't:d1', chunk: 'Looking' })
    messages = applyDelegateActivity(messages, { kind: 'assistant', taskId: 't', delegateId: 't:d1', text: 'Done.' })

    expect(messages).toHaveLength(1)
    expect(messages[0].delegate?.tools).toEqual([{ toolId: 't:d1:x', name: 'shell', detail: 'ls', state: 'done' }])
    expect(messages[0].delegate?.said).toBe('Done.')
  })

  it('drops activity for a card that is no longer in the chat', () => {
    const messages: AgentMessage[] = [{ role: 'user', text: 'hi' }]
    expect(applyDelegateActivity(messages, { kind: 'output', taskId: 't', delegateId: 'gone', chunk: 'x' })).toBe(messages)
  })
})
