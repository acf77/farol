/**
 * Jev — TypeSafe AI's evaluation model, reached through Vercel's AI Gateway.
 *
 * Jev writes no text. It scores a state against typed questions and answers
 * with probabilities, which rules it out as a coding agent but suits the yes/no
 * calls Farol makes about its own runs. So it is wired in as an internal
 * capability rather than another entry in the model pickers: no `AiProvider`
 * entry, nothing in Chat, nothing a pipeline step can select.
 */

import type { Pipeline } from './types'

export const JEV_MODEL_ID = 'typesafe-ai/jev'
export const AI_GATEWAY_API_URL = 'https://ai-gateway.vercel.sh/v1'

/** The one question shape Farol asks. Jev also answers `choice` and `score`. */
export interface JevBooleanQuestion {
  type: 'boolean'
  instructions: string
  criteria?: { true: string; false: string }
}

/** Jev's estimate of P(true), in [0, 1]. */
export interface JevBooleanAnswer {
  type: 'boolean'
  probability: number
}

/** How sure Jev has to be before Farol acts on a step-verdict answer. */
export const JEV_CONFIDENCE = 0.85

/**
 * One-sided bar for additive pipeline selection. Only `p >= threshold` adds a
 * pipeline; anything lower is a clean "do not add," not a tri-state verdict.
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

/** Selection only cares about confident-true; below the bar means do not add. */
export function decideSelection(
  answer: JevBooleanAnswer,
  threshold = JEV_SELECTION_THRESHOLD
): boolean {
  const p = answer.probability
  return Number.isFinite(p) && p >= threshold
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
  const remote = pipeline.target === 'remote' ? ' [remote]' : ''
  const body = `${pipeline.name} (${pipeline.id})${remote}${steps ? `: ${steps}` : ''}`
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

/**
 * One boolean per opted-in, non-mandatory pipeline. Mandatory pipelines always
 * run and are never asked about. Pipelines without `autoSelectable` stay
 * manual so release/mutation workflows cannot fire from a hesitant score.
 * Keyed by pipeline id so a `true` answer maps straight back to a catalog id.
 */
export function pipelineSelectionQuestions(candidates: Pipeline[]): Record<string, JevBooleanQuestion> {
  return Object.fromEntries(
    candidates
      .filter((pipeline) => pipeline.mandatory !== true && pipeline.autoSelectable === true)
      .map((pipeline) => {
        const description = describePipeline(pipeline)
        return [
          pipeline.id,
          {
            type: 'boolean',
            instructions:
              `Should Farol add this pipeline to the turn's validation run?\n` +
              `Pipeline: ${description}`,
            criteria: {
              true:
                'positive evidence that this pipeline adds material coverage for the observed changes, ' +
                'and it is not already covered by selected or mandatory pipelines',
              false:
                'unrelated to the changes, already covered, insufficient evidence, ' +
                'or it performs release/deployment/version mutations not explicitly warranted by the turn'
            }
          } satisfies JevBooleanQuestion
        ]
      })
  )
}
