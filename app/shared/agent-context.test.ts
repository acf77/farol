import { describe, expect, it } from 'vitest'
import {
  HANDOFF_MARKER,
  addFollowUp,
  historyText,
  newAgentContext,
  parseHandoffMarker,
  restoredAgentContext,
  resumableSession,
  sanitizeAgentContext,
  sanitizeSavedAgentContext
} from './agent-context'
import { stripControlMarkerLines } from './control-line'

describe('historyText', () => {
  it('lists the task and every follow-up when they fit', () => {
    const context = addFollowUp(addFollowUp(newAgentContext('Fix the widget'), 'add a test'), 'rename it')
    expect(historyText(context)).toBe('Fix the widget\n\nFollow-up: add a test\n\nFollow-up: rename it')
  })

  it('keeps the task and drops the oldest follow-ups first when over budget', () => {
    let context = newAgentContext('THE ORIGINAL TASK')
    for (let i = 0; i < 50; i++) context = addFollowUp(context, `message ${i} ${'x'.repeat(100)}`)
    const text = historyText(context, 2_000)
    expect(text.length).toBeLessThanOrEqual(2_000)
    expect(text.startsWith('THE ORIGINAL TASK')).toBe(true)
    expect(text).toContain('message 49')
    expect(text).not.toContain('message 0 ')
    expect(text).toMatch(/Farol left out \d+ earlier follow-ups/)
  })

  it('keeps the end of one follow-up that alone exceeds the budget', () => {
    const context = addFollowUp(newAgentContext('task'), `${'a'.repeat(5_000)}THE END`)
    const text = historyText(context, 1_000)
    expect(text.length).toBeLessThanOrEqual(1_000)
    expect(text).toContain('THE END')
    expect(text).toContain('characters omitted')
  })

  it('caps a huge task so it cannot crowd out the latest message', () => {
    const context = addFollowUp(newAgentContext(`${'log '.repeat(10_000)}`), 'the actual ask')
    const text = historyText(context, 4_000)
    expect(text.length).toBeLessThanOrEqual(4_000)
    expect(text).toContain('Follow-up: the actual ask')
  })
})

describe('parseHandoffMarker', () => {
  it('reads a JSON string with line breaks', () => {
    expect(parseHandoffMarker(`Done.\n${HANDOFF_MARKER} "Did A.\\nNext: B"\nFAROL_PIPELINES: []`)).toBe(
      'Did A.\nNext: B'
    )
  })

  it('accepts plain text and keeps the last line', () => {
    expect(parseHandoffMarker(`${HANDOFF_MARKER} first\n${HANDOFF_MARKER} second`)).toBe('second')
  })

  it('ignores a marker inside a code example', () => {
    expect(parseHandoffMarker(`\`\`\`\n${HANDOFF_MARKER} "example"\n\`\`\``)).toBeUndefined()
  })

  it('caps the note', () => {
    expect(parseHandoffMarker(`${HANDOFF_MARKER} ${'n'.repeat(10_000)}`)?.length).toBe(4_000)
  })

  it('is hidden from the transcript like the other control lines', () => {
    expect(stripControlMarkerLines(`Done.\n${HANDOFF_MARKER} "note"`)).toBe('Done.')
  })
})

describe('resumableSession', () => {
  const context = { ...newAgentContext('task'), session: { cli: 'claude' as const, id: 's1', cwd: '/repo' } }

  it('resumes only the same CLI in the same directory', () => {
    expect(resumableSession(context, 'claude', '/repo')).toBe('s1')
    expect(resumableSession(context, 'codex', '/repo')).toBeUndefined()
    expect(resumableSession(context, 'claude', '/repo/sub')).toBeUndefined()
  })

  it('never resumes OMP', () => {
    expect(
      resumableSession({ ...context, session: { cli: 'omp', id: 's1', cwd: '/repo' } }, 'omp', '/repo')
    ).toBeUndefined()
  })
})

describe('sanitizing saved context', () => {
  it('drops invalid sessions and keeps the handoff', () => {
    expect(
      sanitizeSavedAgentContext({ handoff: ' note ', session: { cli: 'omp', id: 'x', cwd: '/r' } })
    ).toEqual({ handoff: 'note' })
    expect(sanitizeSavedAgentContext({ session: { cli: 'codex', id: 't1', cwd: '/r' } })).toEqual({
      session: { cli: 'codex', id: 't1', cwd: '/r' }
    })
    expect(sanitizeSavedAgentContext({})).toBeUndefined()
    expect(sanitizeSavedAgentContext('nope')).toBeUndefined()
  })

  it('requires a task in a full context', () => {
    expect(sanitizeAgentContext({ followUps: ['x'] })).toBeUndefined()
    expect(sanitizeAgentContext({ task: 't', followUps: ['a', 3, ''] })).toEqual({ task: 't', followUps: ['a'] })
  })

  it('rebuilds a chat from its user messages and saved context', () => {
    expect(
      restoredAgentContext(['Fix it', 'also this'], {
        handoff: 'Fixed A',
        session: { cli: 'claude', id: 's1', cwd: '/r' }
      })
    ).toEqual({
      task: 'Fix it',
      followUps: ['also this'],
      handoff: 'Fixed A',
      session: { cli: 'claude', id: 's1', cwd: '/r' }
    })
    expect(restoredAgentContext([], { handoff: 'x' })).toBeUndefined()
  })
})
