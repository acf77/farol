/**
 * Managed Chat Tool policy — which capability families an agent turn may use.
 *
 * Inspection (read/search) is always available. Optional families — edit, shell,
 * web — stay on unless Jev is confidently sure the turn can finish without them.
 * Mid-confidence, missing answers, and gateway failures fail open to the full set.
 */

import { clip, decide, JEV_CONFIDENCE, type JevBooleanAnswer, type JevBooleanQuestion } from './jev'
import { isWriteToolName } from './mandatory'
import { isShellToolName } from './catalog-shell'
import type { AiProvider } from './ai'
import { cliFor } from './ai'

/** Optional families Jev may confidently omit. */
export const TOOL_OPTIONAL = ['edit', 'shell', 'web'] as const
export type ToolCapabilityId = (typeof TOOL_OPTIONAL)[number]

export const JEV_TOOL_CONFIDENCE = JEV_CONFIDENCE
/** Pre-turn budget for tool selection — shorter than pipeline selection. */
export const TOOL_SELECTION_TIMEOUT_MS = 1000

const TASK_STATE_CAP = 800
const OPENING_STATE_CAP = 1_500

export type ToolEnforcement = 'native' | 'prompt'

export type ToolSelection =
  | { kind: 'selected'; kept: ToolCapabilityId[]; omitted: ToolCapabilityId[] }
  | { kind: 'fallback-full'; reason: string }
  | { kind: 'plan' }

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

/** Decision state for selection — never logged; only its size is recorded. */
export function toolSelectionState(ctx: ToolSelectionContext): string {
  return [
    `Mode: ${ctx.mode}`,
    `Attempt: ${ctx.attempt}`,
    `Task: ${clip(ctx.task, TASK_STATE_CAP)}`,
    `Opening (excerpt): ${clip(ctx.opening, OPENING_STATE_CAP)}`
  ].join('\n')
}

/**
 * One boolean per optional capability. False means the turn can clearly finish
 * without that family — the only case Farol will omit it.
 */
const CAPABILITY_CRITERIA: Record<
  ToolCapabilityId,
  { true: string; false: string }
> = {
  edit: {
    true: 'the turn must create, modify, or delete project files',
    false: 'the turn can finish by inspecting the project and answering without file changes'
  },
  shell: {
    true: 'the turn must run a mutating or non-inspection shell/terminal command',
    false: 'the turn can finish with read/search tools only (no bash/terminal commands)'
  },
  web: {
    true: 'the turn must fetch or search the public web',
    false: 'the turn can finish from the local checkout without web access'
  }
}

export function toolSelectionQuestions(): Record<string, JevBooleanQuestion> {
  return Object.fromEntries(
    TOOL_OPTIONAL.map((id) => [
      id,
      {
        type: 'boolean',
        instructions:
          `Does this managed Chat turn need the "${id}" capability?\n` +
          `Answer near 1.0 only when the turn cannot finish without it. ` +
          `Answer near 0.0 only when the turn can clearly finish without it.`,
        criteria: CAPABILITY_CRITERIA[id]
      } satisfies JevBooleanQuestion
    ])
  )
}

/** Keep an optional family unless Jev is confidently sure it is unnecessary. */
export function keepOptionalCapability(
  answer: JevBooleanAnswer | undefined,
  confidence = JEV_TOOL_CONFIDENCE
): boolean {
  if (!answer) return true
  return decide(answer, confidence) !== false
}

export function selectionFromAnswers(
  answers: Record<string, JevBooleanAnswer | undefined>,
  confidence = JEV_TOOL_CONFIDENCE
): Extract<ToolSelection, { kind: 'selected' }> {
  const kept: ToolCapabilityId[] = []
  const omitted: ToolCapabilityId[] = []
  for (const id of TOOL_OPTIONAL) {
    if (keepOptionalCapability(answers[id], confidence)) kept.push(id)
    else omitted.push(id)
  }
  return { kind: 'selected', kept, omitted }
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
  if (selection.kind === 'plan') return ['web']
  return [...selection.kept]
}

/** Remap a cached selection onto the current provider's enforcement path. */
export function toolPolicyFor(provider: AiProvider, selection: ToolSelection): ToolPolicy {
  const allowed = allowedFrom(selection)
  const enforcement = toolEnforcementFor(provider)
  return {
    selection,
    allowed,
    enforcement,
    nativeTools:
      enforcement === 'native' && selection.kind !== 'fallback-full'
        ? nativeToolsFor(provider, allowed)
        : []
  }
}

export function fullToolPolicy(provider: AiProvider, reason: string): ToolPolicy {
  return toolPolicyFor(provider, { kind: 'fallback-full', reason })
}

export function planToolPolicy(provider: AiProvider): ToolPolicy {
  return toolPolicyFor(provider, { kind: 'plan' })
}

/**
 * Prompt clause for every provider. Capability families — not CLI tool names —
 * so a cached selection remaps across provider fallback without a new Jev call.
 * When shell is omitted, read-only shell inspection remains allowed for CLIs
 * that have no separate read tool.
 */
export function toolPolicyPrompt(policy: ToolPolicy): string {
  if (policy.selection.kind === 'plan') {
    return (
      'Tool policy: Plan mode is read-only. You may inspect the project with read/search tools ' +
      '(and read-only shell inspection only when that is how this provider reads files), and you ' +
      'may use web tools to research. Do not edit files or run mutating shell commands.'
    )
  }
  if (policy.selection.kind === 'fallback-full') {
    return ''
  }
  const omitted = policy.selection.omitted
  if (!omitted.length) {
    return (
      'Tool policy: You may use inspection, edit, shell, and web tools as needed for this turn. ' +
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
    `Tool policy (mandatory): Allowed capability families: ${allowed}. ` +
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
