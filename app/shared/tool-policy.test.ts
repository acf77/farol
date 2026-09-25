import { describe, expect, it } from 'vitest'
import {
  capabilityForToolName,
  claudeToolsFor,
  FOCUS_ALLOWED,
  fullToolPolicy,
  observeToolUse,
  ompToolsFor,
  planToolPolicy,
  selectionFromChoice,
  TOOL_FOCI,
  toolEnforcementFor,
  toolFocusFingerprint,
  toolPolicyFor,
  toolPolicyPrompt,
  toolSelectionQuestions,
  toolSelectionState,
  TOOL_OPTIONAL,
  validateToolSelection,
  type ToolSelection
} from './tool-policy'

const choice = (id: string, probability = 0.95) => ({
  type: 'choice' as const,
  choice: id,
  probabilities: Object.fromEntries(TOOL_FOCI.map((focus) => [focus, focus === id ? probability : 0.01]))
})

describe('selectionFromChoice', () => {
  const fingerprint = toolFocusFingerprint()

  it('maps a confident focus onto kept/omitted families', () => {
    expect(selectionFromChoice(choice('implement'), { fingerprint })).toEqual({
      kind: 'selected',
      focus: 'implement',
      kept: ['edit', 'shell'],
      omitted: ['web'],
      candidatesFingerprint: fingerprint
    })
    expect(selectionFromChoice(choice('inspect'), { fingerprint })?.kept).toEqual([])
    expect(selectionFromChoice(choice('verify'), { fingerprint })?.kept).toEqual(['shell'])
  })

  it('abstains on low confidence, foreign ids, and fingerprint drift', () => {
    expect(selectionFromChoice(choice('implement', 0.4), { fingerprint })).toBe(null)
    expect(selectionFromChoice(choice('ghost'), { fingerprint })).toBe(null)
    expect(
      selectionFromChoice(choice('implement'), { fingerprint, currentFingerprint: 'stale' })
    ).toBe(null)
  })
})

describe('validateToolSelection', () => {
  it('fails open when the cached focus set drifted', () => {
    const selection: ToolSelection = {
      kind: 'selected',
      focus: 'implement',
      kept: ['edit', 'shell'],
      omitted: ['web'],
      candidatesFingerprint: 'old'
    }
    expect(validateToolSelection(selection)).toEqual({
      kind: 'fallback-full',
      reason: 'stale-candidates'
    })
  })

  it('rewrites kept/omitted from the live focus map', () => {
    const fingerprint = toolFocusFingerprint()
    const selection: ToolSelection = {
      kind: 'selected',
      focus: 'verify',
      kept: ['edit'],
      omitted: ['shell', 'web'],
      candidatesFingerprint: fingerprint
    }
    expect(validateToolSelection(selection)).toEqual({
      kind: 'selected',
      focus: 'verify',
      kept: [...FOCUS_ALLOWED.verify],
      omitted: ['edit', 'web'],
      candidatesFingerprint: fingerprint
    })
  })
})

describe('toolSelectionQuestions', () => {
  it('asks one Choice over the host-prepared foci', () => {
    const questions = toolSelectionQuestions()
    expect(Object.keys(questions)).toEqual(['focus'])
    expect(questions.focus.type).toBe('choice')
    expect(Object.keys(questions.focus.criteria).sort()).toEqual([...TOOL_FOCI].sort())
    expect(questions.focus.criteria.implement).toMatch(/modify project files/i)
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
  it('uses native enforcement for Claude and OMP with mapped tools', () => {
    const selection: ToolSelection = {
      kind: 'selected',
      focus: 'implement',
      kept: ['edit', 'shell'],
      omitted: ['web'],
      candidatesFingerprint: toolFocusFingerprint()
    }
    const claude = toolPolicyFor('claude', selection)
    expect(claude.enforcement).toBe('native')
    expect(claude.nativeTools).toEqual(claudeToolsFor(['edit', 'shell']))
    expect(claude.nativeTools).toContain('Read')
    expect(claude.nativeTools).toContain('Edit')
    expect(claude.nativeTools).toContain('Bash')
    expect(claude.nativeTools).not.toContain('WebSearch')

    const omp = toolPolicyFor('omp', selection)
    expect(omp.enforcement).toBe('native')
    expect(omp.nativeTools).toEqual(ompToolsFor(['edit', 'shell']))
    expect(omp.nativeTools).toContain('read')
    expect(omp.nativeTools).toContain('bash')
    expect(omp.nativeTools).not.toContain('web_search')
  })

  it('uses prompt enforcement for Codex, Cursor, OpenCode, and OpenRouter', () => {
    const selection: ToolSelection = {
      kind: 'selected',
      focus: 'implement',
      kept: ['edit', 'shell'],
      omitted: ['web'],
      candidatesFingerprint: toolFocusFingerprint()
    }
    for (const provider of ['codex', 'cursor', 'opencode', 'openrouter'] as const) {
      expect(toolEnforcementFor(provider)).toBe('prompt')
      const policy = toolPolicyFor(provider, selection)
      expect(policy.nativeTools).toEqual([])
      expect(toolPolicyPrompt(policy)).toMatch(/Focus "implement"/i)
      expect(toolPolicyPrompt(policy)).toMatch(/Do not use:.*web fetch\/search/i)
    }
  })

  it('fails open to the full set without native argv when fallback-full', () => {
    const policy = fullToolPolicy('claude', 'no-key')
    expect(policy.allowed).toEqual([...TOOL_OPTIONAL])
    expect(policy.nativeTools).toEqual([])
    expect(toolPolicyPrompt(policy)).toBe('')
  })

  it('applies a Plan ceiling with no optional families', () => {
    const policy = planToolPolicy('codex')
    expect(policy.allowed).toEqual([])
    expect(toolPolicyPrompt(policy)).toMatch(/Plan mode is read-only/i)
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
  it('records omitted-family violations without treating inspection as a violation', () => {
    const policy = toolPolicyFor('cursor', {
      kind: 'selected',
      focus: 'implement',
      kept: ['edit', 'shell'],
      omitted: ['web'],
      candidatesFingerprint: toolFocusFingerprint()
    })
    const observation = observeToolUse(policy, ['Read', 'Bash', 'WebFetch', 'mystery'])
    expect(observation.used).toEqual(['shell', 'web'])
    expect(observation.violations).toEqual(['web'])
    expect(observation.unknownCount).toBe(1)
  })
})
