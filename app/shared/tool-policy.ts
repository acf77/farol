/**
 * Managed Chat Tool policy — which capability families an agent turn may use.
 *
 * Inspection (read/search) is always available. Build-mode turns ask Jev for
 * one host-prepared focus (`inspect` / `implement` / `verify` / `answer`); the
 * focus maps to optional families. Mid-confidence, unknown ids, fingerprint
 * drift, and gateway failures fail open to the full set.
 */

import {
  acceptPreparedChoice,
  clip,
  fingerprintIds,
  type JevChoiceAnswer,
  type JevChoiceQuestion
} from './jev'
import { isWriteToolName } from './mandatory'
import { isShellToolName } from './catalog-shell'
import type { AiProvider } from './ai'
import { cliFor } from './ai'

/** Optional families a focus may admit. */
export const TOOL_OPTIONAL = ['edit', 'shell', 'web'] as const
export type ToolCapabilityId = (typeof TOOL_OPTIONAL)[number]

/** Host-prepared foci for one Build-mode turn. */
export const TOOL_FOCI = ['inspect', 'implement', 'verify', 'answer'] as const
export type ToolFocusId = (typeof TOOL_FOCI)[number]

/** Read-only foci Plan mode may choose. Never edit / shell / web. */
export const PLAN_FOCI = ['inspect', 'answer'] as const
export type PlanFocusId = (typeof PLAN_FOCI)[number]

/** Optional families each focus admits. Inspection tools always stay on. */
export const FOCUS_ALLOWED: Record<ToolFocusId, readonly ToolCapabilityId[]> = {
  inspect: [],
  implement: ['edit', 'shell'],
  verify: ['shell'],
  answer: []
}

export const JEV_TOOL_CONFIDENCE = 0.85
/** Pre-turn budget for tool selection — shorter than pipeline selection. */
export const TOOL_SELECTION_TIMEOUT_MS = 1000

const TASK_STATE_CAP = 800
const OPENING_STATE_CAP = 1_500

export type ToolEnforcement = 'native' | 'prompt'

export type ToolSelection =
  | {
      kind: 'selected'
      focus: ToolFocusId
      kept: ToolCapabilityId[]
      omitted: ToolCapabilityId[]
      /** Fingerprint of the focus option set at ask time. */
      candidatesFingerprint: string
    }
  | { kind: 'fallback-full'; reason: string }
  | {
      kind: 'plan'
      /** Read-only focus — inspection tools stay on; optional families stay off. */
      focus: PlanFocusId
      candidatesFingerprint: string
    }

export interface ToolPolicy {
  selection: ToolSelection
  /** Optional families still allowed after selection / fallback / plan ceiling. */
  allowed: ToolCapabilityId[]
  enforcement: ToolEnforcement
  /** Native argv list when enforcement is native; otherwise empty. */
  nativeTools: string[]
}

export interface ToolSelectionContext {
  task: string
  opening: string
  mode: 'plan' | 'build'
  attempt: number
}

export interface ToolObservation {
  used: ToolCapabilityId[]
  unknownCount: number
  /** Optional families used while omitted by the active policy (diagnostic only). */
  violations: ToolCapabilityId[]
}

export function toolFocusFingerprint(mode: 'plan' | 'build' = 'build'): string {
  return fingerprintIds(mode === 'plan' ? PLAN_FOCI : TOOL_FOCI)
}

/** Decision state for selection — never logged; only its size is recorded. */
export function toolSelectionState(ctx: ToolSelectionContext): string {
  return [
    `Mode: ${ctx.mode}`,
    `Attempt: ${ctx.attempt}`,
    `Task: ${clip(ctx.task, TASK_STATE_CAP)}`,
    `Opening (excerpt): ${clip(ctx.opening, OPENING_STATE_CAP)}`
  ].join('\n')
}

const FOCUS_CRITERIA: Record<ToolFocusId, string> = {
  inspect:
    'Read and search the project only — answer or diagnose without editing files, mutating shell commands, or web access',
  implement:
    'Create or modify project files; shell may run for builds/tests tied to the change; no public web',
  verify:
    'Run checks, tests, or lint via shell without editing files or using the public web',
  answer:
    'Reply from context already gathered — no file edits, no shell, no web'
}

/** One Choice over host-prepared Build foci. */
export function toolSelectionQuestions(
  mode: 'plan' | 'build' = 'build'
): Record<string, JevChoiceQuestion> {
  if (mode === 'plan') {
    return {
      focus: {
        type: 'choice',
        instructions:
          'Which read-only focus should this managed Chat Plan turn use? Pick exactly one. ' +
          'Plan mode may inspect the project with read/search tools but must not edit, run mutating shell, or use the web.',
        criteria: {
          inspect: FOCUS_CRITERIA.inspect,
          answer: FOCUS_CRITERIA.answer
        }
      }
    }
  }
  return {
    focus: {
      type: 'choice',
      instructions:
        'Which focus should this managed Chat Build turn use? Pick exactly one. ' +
        'Inspection (read/search) stays available under every focus.',
      criteria: { ...FOCUS_CRITERIA }
    }
  }
}

/** Safe Plan default when Jev abstains — read-only inspection tools stay on. */
export function defaultPlanSelection(): Extract<ToolSelection, { kind: 'plan' }> {
  return {
    kind: 'plan',
    focus: 'inspect',
    candidatesFingerprint: toolFocusFingerprint('plan')
  }
}

export function allowedForFocus(focus: ToolFocusId): ToolCapabilityId[] {
  return [...FOCUS_ALLOWED[focus]]
}

export function omittedForFocus(focus: ToolFocusId): ToolCapabilityId[] {
  const kept = new Set(FOCUS_ALLOWED[focus])
  return TOOL_OPTIONAL.filter((id) => !kept.has(id))
}

/**
 * Map a Choice answer onto a Build selection, or abstain when the id is foreign,
 * the fingerprint drifted, or the winning probability is below the bar.
 */
export function selectionFromChoice(
  answer: JevChoiceAnswer | undefined,
  opts: {
    mode?: 'plan' | 'build'
    fingerprint: string
    currentFingerprint?: string
    threshold?: number
  }
): ToolSelection | null {
  const mode = opts.mode ?? 'build'
  const prepared = mode === 'plan' ? PLAN_FOCI : TOOL_FOCI
  const currentFingerprint = opts.currentFingerprint ?? toolFocusFingerprint(mode)
  const focus = acceptPreparedChoice(answer, prepared, {
    fingerprint: opts.fingerprint,
    currentFingerprint,
    threshold: opts.threshold ?? JEV_TOOL_CONFIDENCE
  })
  if (!focus) return null
  if (mode === 'plan') {
    return {
      kind: 'plan',
      focus: focus as PlanFocusId,
      candidatesFingerprint: currentFingerprint
    }
  }
  return {
    kind: 'selected',
    focus: focus as ToolFocusId,
    kept: allowedForFocus(focus as ToolFocusId),
    omitted: omittedForFocus(focus as ToolFocusId),
    candidatesFingerprint: currentFingerprint
  }
}

/** Re-check a cached selection against the live focus set before remapping. */
export function validateToolSelection(selection: ToolSelection): ToolSelection {
  if (selection.kind === 'fallback-full') return selection
  if (selection.kind === 'plan') {
    if (selection.candidatesFingerprint !== toolFocusFingerprint('plan')) {
      return defaultPlanSelection()
    }
    if (!(PLAN_FOCI as readonly string[]).includes(selection.focus)) {
      return defaultPlanSelection()
    }
    return selection
  }
  if (selection.candidatesFingerprint !== toolFocusFingerprint('build')) {
    return { kind: 'fallback-full', reason: 'stale-candidates' }
  }
  if (!(TOOL_FOCI as readonly string[]).includes(selection.focus)) {
    return { kind: 'fallback-full', reason: 'unknown-focus' }
  }
  const kept = allowedForFocus(selection.focus)
  const omitted = omittedForFocus(selection.focus)
  if (
    kept.length !== selection.kept.length ||
    kept.some((id, i) => id !== selection.kept[i]) ||
    omitted.length !== selection.omitted.length ||
    omitted.some((id, i) => id !== selection.omitted[i])
  ) {
    return {
      kind: 'selected',
      focus: selection.focus,
      kept,
      omitted,
      candidatesFingerprint: selection.candidatesFingerprint
    }
  }
  return selection
}

export function toolEnforcementFor(provider: AiProvider): ToolEnforcement {
  const cli = cliFor(provider)
  return cli === 'claude' || cli === 'omp' ? 'native' : 'prompt'
}

/** Claude built-ins for the active policy. AskUserQuestion stays so Farol choosers work. */
export function claudeToolsFor(allowed: ToolCapabilityId[]): string[] {
  const tools = ['Read', 'Glob', 'Grep', 'AskUserQuestion']
  if (allowed.includes('edit')) tools.push('Edit', 'Write', 'NotebookEdit')
  if (allowed.includes('shell')) tools.push('Bash')
  if (allowed.includes('web')) tools.push('WebFetch', 'WebSearch')
  return tools
}

/** OMP built-ins for the active policy. */
export function ompToolsFor(allowed: ToolCapabilityId[]): string[] {
  const tools = ['read', 'glob', 'grep', 'lsp']
  if (allowed.includes('edit')) tools.push('edit', 'write', 'notebook')
  if (allowed.includes('shell')) tools.push('bash', 'python')
  if (allowed.includes('web')) tools.push('web_search', 'browser')
  return tools
}

export function nativeToolsFor(provider: AiProvider, allowed: ToolCapabilityId[]): string[] {
  const cli = cliFor(provider)
  if (cli === 'claude') return claudeToolsFor(allowed)
  if (cli === 'omp') return ompToolsFor(allowed)
  return []
}

function allowedFrom(selection: ToolSelection): ToolCapabilityId[] {
  if (selection.kind === 'fallback-full') return [...TOOL_OPTIONAL]
  if (selection.kind === 'plan') return []
  return [...selection.kept]
}

/** Remap a cached selection onto the current provider's enforcement path. */
export function toolPolicyFor(provider: AiProvider, selection: ToolSelection): ToolPolicy {
  const validated = validateToolSelection(selection)
  const allowed = allowedFrom(validated)
  const enforcement = toolEnforcementFor(provider)
  return {
    selection: validated,
    allowed,
    enforcement,
    nativeTools:
      enforcement === 'native' && validated.kind !== 'fallback-full'
        ? nativeToolsFor(provider, allowed)
        : []
  }
}

export function fullToolPolicy(provider: AiProvider, reason: string): ToolPolicy {
  return toolPolicyFor(provider, { kind: 'fallback-full', reason })
}

export function planToolPolicy(provider: AiProvider, focus: PlanFocusId = 'inspect'): ToolPolicy {
  return toolPolicyFor(provider, {
    kind: 'plan',
    focus,
    candidatesFingerprint: toolFocusFingerprint('plan')
  })
}

/**
 * Prompt clause for every provider. Capability families — not CLI tool names —
 * so a cached selection remaps across provider fallback without a new Jev call.
 * When shell is omitted, read-only shell inspection remains allowed for CLIs
 * that have no separate read tool.
 */
export function toolPolicyPrompt(policy: ToolPolicy): string {
  if (policy.selection.kind === 'plan') {
    const focus = policy.selection.focus
    return (
      `Tool policy: Plan mode is read-only (focus "${focus}"). ` +
      'You may inspect the project with read/search tools ' +
      '(and read-only shell inspection only when that is how this provider reads files). ' +
      'Do not edit files, run mutating shell commands, or use web tools.'
    )
  }
  if (policy.selection.kind === 'fallback-full') {
    return ''
  }
  const focus = policy.selection.focus
  const omitted = policy.selection.omitted
  if (!omitted.length) {
    return (
      `Tool policy: Focus "${focus}". You may use inspection, edit, shell, and web tools as needed for this turn. ` +
      'Do not call unknown custom or Farol MCP tools — use FAROL control lines instead.'
    )
  }
  const forbidden = omitted
    .map((id) =>
      id === 'edit'
        ? 'file edits/writes/deletes'
        : id === 'shell'
          ? 'mutating shell/terminal commands (read-only shell inspection is allowed when this provider has no separate read tool)'
          : 'web fetch/search'
    )
    .join('; ')
  const allowed = ['inspection (read/search)', ...policy.allowed].join(', ')
  return (
    `Tool policy (mandatory): Focus "${focus}". Allowed capability families: ${allowed}. ` +
    `Do not use: ${forbidden}. ` +
    `Do not call unknown custom or Farol MCP tools — use FAROL control lines instead.`
  )
}

const INSPECT_TOOLS = new Set([
  'read',
  'readfile',
  'glob',
  'grep',
  'search',
  'semanticsearch',
  'lsp',
  'list',
  'ls',
  'askuserquestion',
  'question'
])
const EDIT_EXTRA = new Set(['notebook', 'notebookedit'])
const SHELL_EXTRA = new Set(['python', 'repl'])
const WEB_TOOLS = new Set(['websearch', 'webfetch', 'browser', 'browseruse'])

/** Map a streamed tool card name to an optional capability, inspection, or unknown. */
export function capabilityForToolName(name: string): ToolCapabilityId | 'inspect' | 'unknown' {
  const n = name.toLowerCase().replace(/[_-]/g, '')
  if (INSPECT_TOOLS.has(n)) return 'inspect'
  if (isWriteToolName(name) || EDIT_EXTRA.has(n)) return 'edit'
  if (isShellToolName(name) || SHELL_EXTRA.has(n)) return 'shell'
  if (WEB_TOOLS.has(n) || n.includes('websearch') || n.includes('webfetch')) return 'web'
  return 'unknown'
}

/** Diagnostic observation of tool cards against the active policy. */
export function observeToolUse(policy: ToolPolicy, toolNames: string[]): ToolObservation {
  const used = new Set<ToolCapabilityId>()
  const violations = new Set<ToolCapabilityId>()
  let unknownCount = 0
  const omitted =
    policy.selection.kind === 'selected' ? new Set(policy.selection.omitted) : new Set<ToolCapabilityId>()
  for (const name of toolNames) {
    const cap = capabilityForToolName(name)
    if (cap === 'inspect') continue
    if (cap === 'unknown') {
      unknownCount += 1
      continue
    }
    used.add(cap)
    if (omitted.has(cap)) violations.add(cap)
  }
  return {
    used: TOOL_OPTIONAL.filter((id) => used.has(id)),
    unknownCount,
    violations: TOOL_OPTIONAL.filter((id) => violations.has(id))
  }
}
