import { describe, expect, it } from 'vitest'
import { managedAiCommand } from './ai'
import {
  capabilityForToolName,
  defaultPlanSelection,
  FOCUS_ALLOWED,
  observeToolUse,
  selectionFromChoice,
  TOOL_FOCI,
  toolFocusFingerprint,
  toolPolicyFor,
  toolPolicyPrompt,
  toolSelectionQuestions,
  toolSelectionState,
  validateToolSelection,
  type ToolSelection
} from './tool-policy'

const choice = (id: string, probability = 0.95) => ({
  type: 'choice' as const,
  choice: id,
  probabilities: Object.fromEntries(TOOL_FOCI.map((focus) => [focus, focus === id ? probability : 0.01]))
})

describe('selectionFromChoice', () => {
  const fingerprint = toolFocusFingerprint('build')

  it('maps a confident focus onto kept/omitted families', () => {
    expect(selectionFromChoice(choice('implement'), { fingerprint })).toEqual({
      kind: 'selected',
      focus: 'implement',
      kept: ['edit'],
      omitted: ['web'],
      candidatesFingerprint: fingerprint
    })
    expect(selectionFromChoice(choice('inspect'), { fingerprint })).toMatchObject({
      kind: 'selected',
      focus: 'inspect',
      kept: []
    })
    expect(selectionFromChoice(choice('verify'), { fingerprint })).toBe(null)
  })

  it('abstains on low confidence, foreign ids, and fingerprint drift', () => {
    expect(selectionFromChoice(choice('implement', 0.4), { fingerprint })).toBe(null)
    expect(selectionFromChoice(choice('ghost'), { fingerprint })).toBe(null)
    expect(
      selectionFromChoice(choice('implement'), { fingerprint, currentFingerprint: 'stale' })
    ).toBe(null)
  })

  it('maps Plan Choice onto read-only plan selections only', () => {
    const planFp = toolFocusFingerprint('plan')
    expect(
      selectionFromChoice(
        { type: 'choice', choice: 'answer', probabilities: { answer: 0.9, inspect: 0.1 } },
        { mode: 'plan', fingerprint: planFp }
      )
    ).toEqual({ kind: 'plan', focus: 'answer', candidatesFingerprint: planFp })
    expect(
      selectionFromChoice(choice('implement'), { mode: 'plan', fingerprint: planFp })
    ).toBe(null)
  })
})

describe('validateToolSelection', () => {
  it('restores only edit/web when the cached Build focus set drifted', () => {
    const selection: ToolSelection = {
      kind: 'selected',
      focus: 'implement',
      kept: ['edit'],
      omitted: ['web'],
      candidatesFingerprint: 'old'
    }
    expect(validateToolSelection(selection)).toEqual({
      kind: 'fallback-full',
      reason: 'stale-candidates'
    })
  })

  it('rewrites kept/omitted from the live focus map', () => {
    const fingerprint = toolFocusFingerprint('build')
    const selection: ToolSelection = {
      kind: 'selected',
      focus: 'inspect',
      kept: ['edit'],
      omitted: ['web'],
      candidatesFingerprint: fingerprint
    }
    expect(validateToolSelection(selection)).toEqual({
      kind: 'selected',
      focus: 'inspect',
      kept: [...FOCUS_ALLOWED.inspect],
      omitted: ['edit', 'web'],
      candidatesFingerprint: fingerprint
    })
  })

  it('soft-fails Plan drift back to inspect, never full tools', () => {
    expect(
      validateToolSelection({
        kind: 'plan',
        focus: 'answer',
        candidatesFingerprint: 'stale'
      })
    ).toEqual(defaultPlanSelection())
  })
})

describe('toolSelectionQuestions', () => {
  it('asks one Choice over the host-prepared Build foci', () => {
    const questions = toolSelectionQuestions('build')
    expect(Object.keys(questions)).toEqual(['focus'])
    expect(questions.focus.type).toBe('choice')
    expect(Object.keys(questions.focus.criteria).sort()).toEqual([...TOOL_FOCI].sort())
    expect(questions.focus.criteria.implement).toMatch(/modify project files/i)
    expect(questions.focus.criteria.implement).toContain('Farol pipelines')
    expect(questions.focus.criteria).not.toHaveProperty('verify')
    expect(questions.focus.instructions).toContain('code execution are disabled')
  })

  it('asks only read-only foci in Plan mode', () => {
    const questions = toolSelectionQuestions('plan')
    expect(Object.keys(questions.focus.criteria).sort()).toEqual(['answer', 'inspect'])
  })
})

describe('toolSelectionState', () => {
  it('bounds task and opening without provider tool names', () => {
    const state = toolSelectionState({
      task: 'x'.repeat(2000),
      opening: 'y'.repeat(2000),
      mode: 'build',
      attempt: 2
    })
    expect(state).toContain('Mode: build')
    expect(state).toContain('Attempt: 2')
    expect(state.length).toBeLessThan(2500)
  })
})

describe('toolPolicyFor', () => {
  it('maps the Build focus to the restricted launch tool list', () => {
    const selection: ToolSelection = {
      kind: 'selected',
      focus: 'implement',
      kept: ['edit'],
      omitted: ['web'],
      candidatesFingerprint: toolFocusFingerprint('build')
    }
    const policy = toolPolicyFor(selection)
    expect(policy.nativeTools).toEqual(['Read', 'Glob', 'Grep', 'AskUserQuestion', 'Edit', 'Write', 'NotebookEdit'])
    const args = managedAiCommand('claude', 'apply the change', undefined, { tools: policy.nativeTools }).args
    expect(args[args.indexOf('--tools') + 1].split(',')).toEqual(policy.nativeTools)
    expect(toolPolicyPrompt(policy)).toMatch(/Do not use:.*web fetch\/search/i)
  })

  it('keeps the execution limit and native tools when selection falls back', () => {
    const policy = toolPolicyFor({ kind: 'fallback-full', reason: 'no-key' })
    expect(policy.allowed).toEqual(['edit', 'web'])
    expect(policy.nativeTools).toContain('Edit')
    expect(policy.nativeTools).toContain('WebSearch')
    expect(policy.nativeTools).not.toContain('Bash')
    expect(toolPolicyPrompt(policy)).toContain('all shell commands and code execution')
  })

  it('applies a Plan ceiling with inspection + web on inspect, never edit/shell', () => {
    const policy = toolPolicyFor(defaultPlanSelection())
    expect(policy.allowed).toEqual(['web'])
    expect(policy.selection).toEqual(defaultPlanSelection())
    expect(toolPolicyPrompt(policy)).toMatch(/Plan mode is read-only \(focus "inspect"\)/i)
    expect(toolPolicyPrompt(policy)).toMatch(/web fetch\/search|web/i)
    expect(toolPolicyPrompt(policy)).toMatch(/Do not use:.*file edits/i)
    expect(toolPolicyPrompt(policy)).toMatch(/all shell commands/i)

    expect(policy.nativeTools).toContain('Read')
    expect(policy.nativeTools).toContain('WebSearch')
    expect(policy.nativeTools).not.toContain('Edit')
    expect(policy.nativeTools).not.toContain('Bash')

    const answer = toolPolicyFor({ kind: 'plan', focus: 'answer', candidatesFingerprint: toolFocusFingerprint('plan') })
    expect(answer.allowed).toEqual([])
    expect(answer.nativeTools).toEqual(['Read', 'Glob', 'Grep', 'AskUserQuestion'])
    expect(answer.nativeTools).not.toContain('WebSearch')
    expect(toolPolicyPrompt(answer)).toMatch(/focus "answer"/i)
  })
})

describe('capabilityForToolName', () => {
  it('classifies known aliases and marks the rest unknown', () => {
    expect(capabilityForToolName('Read')).toBe('inspect')
    expect(capabilityForToolName('StrReplace')).toBe('edit')
    expect(capabilityForToolName('Bash')).toBe('shell')
    expect(capabilityForToolName('WebSearch')).toBe('web')
    expect(capabilityForToolName('farol.run_pipeline')).toBe('unknown')
    expect(capabilityForToolName('CreateGoal')).toBe('unknown')
  })
})

describe('observeToolUse', () => {
  it('reports execution under fallback and edits in Plan as violations', () => {
    const fallback = toolPolicyFor({ kind: 'fallback-full', reason: 'no-key' })
    expect(observeToolUse(fallback, ['Bash', 'Edit']).violations).toEqual(['shell'])
    expect(observeToolUse(toolPolicyFor(defaultPlanSelection()), ['Write', 'python', 'WebFetch']).violations).toEqual(['edit', 'shell'])
  })


  it('records omitted-family violations without treating inspection as a violation', () => {
    const policy = toolPolicyFor({
      kind: 'selected',
      focus: 'implement',
      kept: ['edit'],
      omitted: ['web'],
      candidatesFingerprint: toolFocusFingerprint('build')
    })
    const observation = observeToolUse(policy, ['Read', 'Bash', 'WebFetch', 'mystery'])
    expect(observation.used).toEqual(['shell', 'web'])
    expect(observation.violations).toEqual(['shell', 'web'])
    expect(observation.unknownCount).toBe(1)
  })
})
