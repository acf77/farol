import { describe, expect, it } from 'vitest'
import {
  capabilityForToolName,
  claudeToolsFor,
  fullToolPolicy,
  keepOptionalCapability,
  observeToolUse,
  ompToolsFor,
  planToolPolicy,
  selectionFromAnswers,
  toolEnforcementFor,
  toolPolicyFor,
  toolPolicyPrompt,
  toolSelectionQuestions,
  toolSelectionState,
  TOOL_OPTIONAL,
  type ToolSelection
} from './tool-policy'

const answer = (probability: number) => ({ type: 'boolean' as const, probability })

describe('keepOptionalCapability', () => {
  it('keeps on true, mid-band, missing, and only omits confident false', () => {
    expect(keepOptionalCapability(answer(0.99))).toBe(true)
    expect(keepOptionalCapability(answer(0.5))).toBe(true)
    expect(keepOptionalCapability(undefined)).toBe(true)
    expect(keepOptionalCapability(answer(0.15))).toBe(false)
    expect(keepOptionalCapability(answer(0.01))).toBe(false)
  })
})

describe('selectionFromAnswers', () => {
  it('omits only capabilities Jev confidently rejects', () => {
    const selection = selectionFromAnswers({
      edit: answer(0.95),
      shell: answer(0.1),
      web: answer(0.4)
    })
    expect(selection).toEqual({ kind: 'selected', kept: ['edit', 'web'], omitted: ['shell'] })
  })
})

describe('toolSelectionQuestions', () => {
  it('asks one polar boolean per optional capability', () => {
    const questions = toolSelectionQuestions()
    expect(Object.keys(questions)).toEqual([...TOOL_OPTIONAL])
    expect(questions.edit.criteria?.false).toMatch(/without file changes/i)
    expect(questions.shell.criteria?.false).toMatch(/read\/search/i)
    expect(questions.web.criteria?.false).toMatch(/without web/i)
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
    const selection: ToolSelection = { kind: 'selected', kept: ['edit'], omitted: ['shell', 'web'] }
    const claude = toolPolicyFor('claude', selection)
    expect(claude.enforcement).toBe('native')
    expect(claude.nativeTools).toEqual(claudeToolsFor(['edit']))
    expect(claude.nativeTools).toContain('Read')
    expect(claude.nativeTools).toContain('Edit')
    expect(claude.nativeTools).not.toContain('Bash')

    const omp = toolPolicyFor('omp', selection)
    expect(omp.enforcement).toBe('native')
    expect(omp.nativeTools).toEqual(ompToolsFor(['edit']))
    expect(omp.nativeTools).toContain('read')
    expect(omp.nativeTools).not.toContain('bash')
  })

  it('uses prompt enforcement for Codex, Cursor, OpenCode, and OpenRouter', () => {
    const selection: ToolSelection = { kind: 'selected', kept: ['edit'], omitted: ['shell', 'web'] }
    for (const provider of ['codex', 'cursor', 'opencode', 'openrouter'] as const) {
      expect(toolEnforcementFor(provider)).toBe('prompt')
      const policy = toolPolicyFor(provider, selection)
      expect(policy.nativeTools).toEqual([])
      expect(toolPolicyPrompt(policy)).toMatch(/Do not use:.*mutating shell/i)
      expect(toolPolicyPrompt(policy)).toMatch(/read-only shell inspection/i)
    }
  })

  it('fails open to the full set without native argv when fallback-full', () => {
    const policy = fullToolPolicy('claude', 'no-key')
    expect(policy.allowed).toEqual([...TOOL_OPTIONAL])
    expect(policy.nativeTools).toEqual([])
    expect(toolPolicyPrompt(policy)).toBe('')
  })

  it('applies a Plan ceiling that keeps web research but blocks edit/shell', () => {
    const policy = planToolPolicy('codex')
    expect(policy.allowed).toEqual(['web'])
    expect(toolPolicyPrompt(policy)).toMatch(/Plan mode is read-only/i)
    expect(toolPolicyPrompt(policy)).toMatch(/may use web tools to research/i)

    const claude = planToolPolicy('claude')
    expect(claude.nativeTools).toContain('WebFetch')
    expect(claude.nativeTools).toContain('WebSearch')
    expect(claude.nativeTools).not.toContain('Edit')
    expect(claude.nativeTools).not.toContain('Bash')
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
      kept: ['edit'],
      omitted: ['shell', 'web']
    })
    const observation = observeToolUse(policy, ['Read', 'Bash', 'WebFetch', 'mystery'])
    expect(observation.used).toEqual(['shell', 'web'])
    expect(observation.violations).toEqual(['shell', 'web'])
    expect(observation.unknownCount).toBe(1)
  })
})
