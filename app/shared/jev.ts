/**
 * Jev — TypeSafe AI's evaluation model, reached through Vercel's AI Gateway.
 *
 * Jev writes no text. It scores a state against typed questions and answers
 * with probabilities, which rules it out as a coding agent but suits the yes/no
 * and closed-choice calls Farol makes about its own runs. So it is wired in as
 * an internal capability rather than another entry in the model pickers: no
 * `AiProvider` entry, nothing in Chat, nothing a pipeline step can select.
 *
 * Booleans gate absolute predicates (step verdicts). Choices pick one opaque
 * host-prepared option (pipeline id, tool focus). The host always re-checks
 * the returned id against the prepared set before applying it.
 */

import type { Pipeline } from './types'

/** Prefer this over `error instanceof Error ? error.message : String(error)`. */
export function errorMessage(err: unknown, fallback?: string): string {
  if (err instanceof Error) return err.message
  return fallback !== undefined ? fallback : String(err)
}

export const JEV_MODEL_ID = 'typesafe-ai/jev'
export const AI_GATEWAY_API_URL = 'https://ai-gateway.vercel.sh/v1'

/** Escape hatch in pipeline Choice criteria — do not add any candidate. */
export const PIPELINE_NONE_ID = 'none'

/** The question shapes Farol asks. */
export interface JevBooleanQuestion {
  type: 'boolean'
  instructions: string
  criteria?: { true: string; false: string }
}

export interface JevChoiceQuestion {
  type: 'choice'
  instructions: string
  /** Nonempty map of option id → description. Null means the id is enough. */
  criteria: Record<string, string | null>
}

export type JevQuestion = JevBooleanQuestion | JevChoiceQuestion

/** Jev's estimate of P(true), in [0, 1]. */
export interface JevBooleanAnswer {
  type: 'boolean'
  probability: number
}

/** Relative pick among the question's criteria keys. */
export interface JevChoiceAnswer {
  type: 'choice'
  choice: string
  probabilities?: Record<string, number>
}

/** How sure Jev has to be before Farol acts on a step-verdict answer. */
export const JEV_CONFIDENCE = 0.85

/**
 * Minimum winning probability for a Choice to apply. Below the bar Farol
 * abstains (pipelines: add nothing; tools: fail open to the full set).
 */
export const JEV_SELECTION_THRESHOLD = 0.85

const STEP_CMD_CAP = 120
const PIPELINE_DESC_CAP = 600
const ASSISTANT_STATE_CAP = 1_500
const TASK_STATE_CAP = 800
const CHANGED_TARGETS_CAP = 24

/**
 * Jev answers with a probability, never a verdict. Anything inside the
 * undecided band reads as `null` so the caller keeps doing whatever it would
 * have done without Jev.
 */
export function decide(answer: JevBooleanAnswer, confidence = JEV_CONFIDENCE): boolean | null {
  const p = answer.probability
  if (!Number.isFinite(p)) return null
  if (p >= confidence) return true
  if (p <= 1 - confidence) return false
  return null
}

/** Winning option's probability when the provider supplies a distribution. */
export function choiceProbability(answer: JevChoiceAnswer): number | undefined {
  const p = answer.probabilities?.[answer.choice]
  return Number.isFinite(p) ? p : undefined
}

/**
 * Accept a Choice only when the id is host-prepared, the candidate fingerprint
 * still matches, and (when known) the winning probability clears the bar.
 * Otherwise abstain — never invent or transplant an option.
 */
export function acceptPreparedChoice(
  answer: JevChoiceAnswer | undefined,
  preparedIds: readonly string[],
  opts: {
    fingerprint: string
    currentFingerprint: string
    threshold?: number
  }
): string | null {
  if (!answer || answer.type !== 'choice') return null
  if (opts.fingerprint !== opts.currentFingerprint) return null
  if (!preparedIds.includes(answer.choice)) return null
  const threshold = opts.threshold ?? JEV_SELECTION_THRESHOLD
  const probability = choiceProbability(answer)
  if (probability !== undefined && probability < threshold) return null
  return answer.choice
}

/** Stable fingerprint of the option set the host prepared for one decision. */
export function fingerprintIds(ids: readonly string[]): string {
  return [...ids].sort().join('\0')
}

/**
 * Compact pipeline definition for Jev: name, id, and bounded step summaries.
 * Large AI prompts (e.g. Slop checker) are truncated so they cannot dominate.
 */
export function describePipeline(pipeline: Pipeline): string {
  const steps = pipeline.nodes
    .map((node) => {
      const cmd = node.cmd.replace(/\s+/g, ' ').trim().slice(0, STEP_CMD_CAP)
      const ellipsis = node.cmd.replace(/\s+/g, ' ').trim().length > STEP_CMD_CAP ? '…' : ''
      return `${node.name} [${node.type}]: ${cmd}${ellipsis}`
    })
    .join('; ')
  const body = `${pipeline.name} (${pipeline.id})${steps ? `: ${steps}` : ''}`
  return body.length > PIPELINE_DESC_CAP ? `${body.slice(0, PIPELINE_DESC_CAP - 1)}…` : body
}

export interface PipelineSelectionContext {
  task: string
  assistant: string
  changedTargets: string[]
  selected: Pipeline[]
  mandatory: Pipeline[]
}

export function clip(text: string, max: number): string {
  const trimmed = text.trim()
  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed
}

/** Decision state for selection — never logged; only its size is recorded. */
export function pipelineSelectionState(ctx: PipelineSelectionContext): string {
  const targets = ctx.changedTargets
    .map((t) => t.trim())
    .filter(Boolean)
    .slice(0, CHANGED_TARGETS_CAP)
  const selected = ctx.selected.map(describePipeline)
  const mandatory = ctx.mandatory.map(describePipeline)
  return [
    `Task: ${clip(ctx.task, TASK_STATE_CAP)}`,
    `Changed targets: ${targets.length ? targets.join(', ') : '(none reported)'}`,
    `Already selected: ${selected.length ? selected.join(' | ') : '(none)'}`,
    `Mandatory (will run): ${mandatory.length ? mandatory.join(' | ') : '(none)'}`,
    `Assistant (excerpt): ${clip(ctx.assistant, ASSISTANT_STATE_CAP)}`
  ].join('\n')
}

/**
 * A known-answer question Settings runs to prove a saved key reaches Jev and
 * that Jev is answering sanely. Deliberately unambiguous: a wrong answer means
 * something is broken, not that the model disagreed.
 */
export const JEV_PROBE = {
  state: 'The pipeline step exited with code 1.',
  questions: {
    failed: {
      type: 'boolean',
      instructions: 'Did the step fail?',
      criteria: { true: 'a non-zero exit code', false: 'exit code 0' }
    }
  }
} satisfies { state: string; questions: Record<string, JevBooleanQuestion> }

export interface PipelineChoicePrep {
  /** Opted-in non-mandatory candidates, in catalog order. */
  candidates: Pipeline[]
  /** Choice criteria including {@link PIPELINE_NONE_ID}. */
  criteria: Record<string, string | null>
  /** Ids Jev may legally return (candidates + none). */
  preparedIds: string[]
  fingerprint: string
}

/**
 * Host-prepared pipeline Choice: one relative pick among opted-in candidates,
 * plus `none`. Mandatory and non-opted-in pipelines are never offered.
 */
export function preparePipelineChoice(candidates: Pipeline[]): PipelineChoicePrep | null {
  const eligible = candidates.filter(
    (pipeline) => pipeline.mandatory !== true && pipeline.autoSelectable === true
  )
  if (!eligible.length) return null
  const criteria: Record<string, string | null> = {
    [PIPELINE_NONE_ID]:
      'Do not add any of these pipelines — unrelated, already covered, or release/mutation work not warranted'
  }
  for (const pipeline of eligible) {
    criteria[pipeline.id] = describePipeline(pipeline)
  }
  const preparedIds = Object.keys(criteria)
  return {
    candidates: eligible,
    criteria,
    preparedIds,
    fingerprint: fingerprintIds(preparedIds)
  }
}

/** Single Choice question for post-turn pipeline auto-selection. */
export function pipelineSelectionQuestions(
  candidates: Pipeline[]
): Record<string, JevChoiceQuestion> {
  const prep = preparePipelineChoice(candidates)
  if (!prep) return {}
  return {
    pipeline: {
      type: 'choice',
      instructions:
        'Which one auto-selectable pipeline should Farol add to this turn\'s validation run? ' +
        'Pick exactly one option. Prefer "none" unless one pipeline adds material coverage ' +
        'for the observed changes that is not already covered by selected or mandatory pipelines.',
      criteria: prep.criteria
    }
  }
}
