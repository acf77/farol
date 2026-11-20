/**
 * Managed Chat Tool policy — which capability families an agent turn may use.
 *
 * Inspection (read/search) is always available. Build-mode turns ask Jev for
 * one host-prepared focus (`inspect` / `implement` / `answer`); the
 * focus maps to optional families. Mid-confidence, unknown ids, fingerprint
 * drift, and gateway failures restore edit/web tools within the execution limit.
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
import { managedClaudeTools } from './ai'

/** Optional families a focus may admit. */
export const TOOL_OPTIONAL = ['edit', 'web'] as const
export type ToolCapabilityId = (typeof TOOL_OPTIONAL)[number]

/** Host-prepared foci for one Build-mode turn. */
export const TOOL_FOCI = ['inspect', 'implement', 'answer'] as const
export type ToolFocusId = (typeof TOOL_FOCI)[number]

/** Read-only foci Plan mode may choose. */
export const PLAN_FOCI = ['inspect', 'answer'] as const
export type PlanFocusId = (typeof PLAN_FOCI)[number]

/** Optional families each Build focus admits. Inspection tools always stay on. */
export const FOCUS_ALLOWED: Record<ToolFocusId, readonly ToolCapabilityId[]> = {
  inspect: [],
  implement: ['edit'],
  answer: []
}

/**
 * Optional families each Plan focus admits. Web search/fetch is read-only
 * research; edits stay off. Execution is never available.
 */
export const PLAN_FOCUS_ALLOWED: Record<PlanFocusId, readonly ToolCapabilityId[]> = {
  inspect: ['web'],
  answer: []
}

export const JEV_TOOL_CONFIDENCE = 0.85
/** Pre-turn budget for tool selection — shorter than pipeline selection. */
export const TOOL_SELECTION_TIMEOUT_MS = 1000

const TASK_STATE_CAP = 800
const OPENING_STATE_CAP = 1_500

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
      /** Read-only focus — inspection (+ web on inspect). */
      focus: PlanFocusId
      candidatesFingerprint: string
    }

export interface ToolPolicy {
  selection: ToolSelection
  /** Optional families still allowed after selection / fallback / plan ceiling. */
  allowed: ToolCapabilityId[]
  /** Claude built-ins passed to the restricted managed launch. */
  nativeTools: string[]
}

export interface ToolSelectionContext {
  task: string
  opening: string
  mode: 'plan' | 'build'
  attempt: number
}

/** Shell can be observed as a violation, but is never an optional capability. */
type ObservedCapability = ToolCapabilityId | 'shell'

export interface ToolObservation {
  used: ObservedCapability[]
  unknownCount: number
  /** Disabled families used in tool cards (diagnostic only). */
  violations: ObservedCapability[]
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
    'Read and search the project only — answer or diagnose without editing files or web access',
  implement:
    'Create or modify project files; request Farol pipelines for checks; no public web',
  answer:
    'Reply from context already gathered — no file edits or web access'
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
          'Plan mode may inspect the project and use web search/fetch when researching, ' +
          'but must not edit files or execute commands.',
        criteria: {
          inspect:
            'Read and search the project, and use web search/fetch when needed to research docs or APIs — no file edits or commands',
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
        'Inspection (read/search) stays available under every focus. ' +
        'Commands and code execution are disabled; request Farol pipelines for checks.',
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

export function allowedForPlanFocus(focus: PlanFocusId): ToolCapabilityId[] {
  return [...PLAN_FOCUS_ALLOWED[focus]]
}

export function omittedForPlanFocus(focus: PlanFocusId): ToolCapabilityId[] {
  const kept = new Set(PLAN_FOCUS_ALLOWED[focus])
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

function allowedFrom(selection: ToolSelection): ToolCapabilityId[] {
  if (selection.kind === 'fallback-full') return [...TOOL_OPTIONAL]
  if (selection.kind === 'plan') return allowedForPlanFocus(selection.focus)
  return [...selection.kept]
}

/** Re-check the cached selection and map it to the managed Claude tools. */
export function toolPolicyFor(selection: ToolSelection): ToolPolicy {
  const validated = validateToolSelection(selection)
  const allowed = allowedFrom(validated)
  return { selection: validated, allowed, nativeTools: managedClaudeTools(allowed) }
}

/** Human-readable description of each omitted capability family, for prompt text. */
const CAPABILITY_FORBIDDEN_LABEL: Record<ToolCapabilityId, string> = {
  edit: 'file edits/writes/deletes',
  web: 'web fetch/search'
}

function forbiddenClause(omitted: ToolCapabilityId[]): string {
  return ['all shell commands and code execution', ...omitted.map((id) => CAPABILITY_FORBIDDEN_LABEL[id])].join('; ')
}

/**
 * Prompt clause for the managed launch. Shell stays off under every focus
 * and fallback; only edit and web access can change.
 */
export function toolPolicyPrompt(policy: ToolPolicy): string {
  if (policy.selection.kind === 'plan') {
    const focus = policy.selection.focus
    const forbidden = forbiddenClause(omittedForPlanFocus(focus))
    const allowed = ['inspection (read/search)', ...policy.allowed].join(', ')
    return (
      `Tool policy: Plan mode is read-only (focus "${focus}"). ` +
      `Allowed capability families: ${allowed}. ` +
      `Do not use: ${forbidden}. ` +
      'Do not call unknown custom or Farol MCP tools — use FAROL control lines instead.'
    )
  }
  const focus = policy.selection.kind === 'fallback-full' ? 'full' : policy.selection.focus
  const omitted = TOOL_OPTIONAL.filter((id) => !policy.allowed.includes(id))
  const forbidden = forbiddenClause(omitted)
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
export function capabilityForToolName(name: string): ObservedCapability | 'inspect' | 'unknown' {
  const n = name.toLowerCase().replace(/[_-]/g, '')
  if (INSPECT_TOOLS.has(n)) return 'inspect'
  if (isWriteToolName(name) || EDIT_EXTRA.has(n)) return 'edit'
  if (isShellToolName(name) || SHELL_EXTRA.has(n)) return 'shell'
  if (WEB_TOOLS.has(n) || n.includes('websearch') || n.includes('webfetch')) return 'web'
  return 'unknown'
}

/** Diagnostic observation of tool cards against the active policy. */
export function observeToolUse(policy: ToolPolicy, toolNames: string[]): ToolObservation {
  const used = new Set<ObservedCapability>()
  const violations = new Set<ObservedCapability>()
  let unknownCount = 0
  for (const name of toolNames) {
    const cap = capabilityForToolName(name)
    if (cap === 'inspect') continue
    if (cap === 'unknown') {
      unknownCount += 1
      continue
    }
    used.add(cap)
    if (cap === 'shell' || !policy.allowed.includes(cap)) violations.add(cap)
  }
  const order: ObservedCapability[] = ['edit', 'shell', 'web']
  return {
    used: order.filter((id) => used.has(id)),
    unknownCount,
    violations: order.filter((id) => violations.has(id))
  }
}
