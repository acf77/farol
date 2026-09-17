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

/** How sure Jev has to be before Farol acts on an answer. */
export const JEV_CONFIDENCE = 0.85

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
 * One boolean Noul per non-mandatory pipeline — mandatory ones always run and
 * are never asked about, which also keeps Jev from ever being the reason a
 * mandatory pipeline is skipped. Keyed by pipeline id, so a `true` answer maps
 * straight back to a catalog id with no room to invent one.
 */
export function pipelineSelectionQuestions(candidates: Pipeline[]): Record<string, JevBooleanQuestion> {
  return Object.fromEntries(
    candidates
      .filter((pipeline) => pipeline.mandatory !== true)
      .map((pipeline) => [
        pipeline.id,
        {
          type: 'boolean',
          instructions: `Should Farol run pipeline "${pipeline.name}" (${pipeline.id}) now to validate this turn?`,
          criteria: {
            true: "this turn's change is the kind of thing this pipeline is meant to catch",
            false: 'this pipeline is unrelated to what changed, or redundant with pipelines already selected'
          }
        } satisfies JevBooleanQuestion
      ])
  )
}

