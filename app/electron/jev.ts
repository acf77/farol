/**
 * Jev, wired in for Farol's own decisions only.
 *
 * It is deliberately absent from `AiProvider`: Jev generates no text, so it can
 * neither hold a chat nor run an `ai` pipeline step. What Settings offers is a
 * Vercel AI Gateway key and a probe that proves the key reaches the model.
 *
 * Evaluation is an AI SDK-only modality — the gateway's OpenAI- and
 * Anthropic-compatible endpoints do not expose it — hence the `ai` dependency
 * rather than the plain `fetch` the OpenRouter catalog uses.
 */

import { createGateway } from '@ai-sdk/gateway'
import { experimental_evaluate as evaluate } from 'ai'
import {
  acceptPreparedChoice,
  choiceProbability,
  decide,
  JEV_CONFIDENCE,
  JEV_MODEL_ID,
  JEV_PROBE,
  JEV_SELECTION_THRESHOLD,
  PIPELINE_NONE_ID,
  pipelineSelectionQuestions,
  preparePipelineChoice,
  type JevBooleanQuestion,
  type JevChoiceAnswer
} from '../shared/jev'
import {
  allowedForPlanFocus,
  defaultPlanSelection,
  JEV_TOOL_CONFIDENCE,
  omittedForPlanFocus,
  selectionFromChoice,
  TOOL_SELECTION_TIMEOUT_MS,
  toolFocusFingerprint,
  toolSelectionQuestions,
  type ToolSelection
} from '../shared/tool-policy'
import type { Pipeline, SettingsResult } from '../shared/types'
import type { StepVerdict } from '../shared/verdict'
import { logJev } from './jev-log'
import { clearSecret, peekSecret, setSecret } from './secrets'
import { loadSettings } from './store'

const NO_KEY = 'Save a Vercel AI Gateway API key first.'

/**
 * Jev's read on `state`: one entry per boolean question, `null` where Jev was
 * not confident enough for Farol to act on. Throws when no key is stored or the
 * gateway refuses, so callers decide whether an outage is fatal.
 */
export async function askJev(
  state: string,
  questions: Record<string, JevBooleanQuestion>,
  opts: { timeoutMs?: number; purpose?: string } = {}
): Promise<Record<string, boolean | null>> {
  const started = Date.now()
  const context = {
    timestamp: new Date(started).toISOString(),
    purpose: opts.purpose ?? 'evaluation',
    model: JEV_MODEL_ID,
    confidence: JEV_CONFIDENCE,
    questionIds: Object.keys(questions)
  }
  const key = peekSecret('aiGatewayApiKey')
  if (!key) {
    logJev({ ...context, status: 'skipped', reason: 'no-key' })
    throw new Error(NO_KEY)
  }
  try {
    const { answers } = await evaluate({
      model: createGateway({ apiKey: key }).evaluationModel(JEV_MODEL_ID),
      state,
      questions,
      abortSignal: opts.timeoutMs ? AbortSignal.timeout(opts.timeoutMs) : undefined
    })
    const decisions = Object.fromEntries(
      Object.keys(questions).map((id) => {
        const answer = answers[id]
        if (!answer || answer.type !== 'boolean') return [id, null]
        return [id, decide(answer)]
      })
    )
    logJev({
      ...context,
      status: 'evaluated',
      durationMs: Date.now() - started,
      decisions: Object.entries(decisions).map(([id, decision]) => {
        const answer = answers[id]
        const probability = answer && answer.type === 'boolean' ? answer.probability : null
        return {
          id,
          probability,
          decision,
          reason: !answer || answer.type !== 'boolean'
            ? 'missing-answer'
            : decision === null
              ? 'inconclusive'
              : 'confident'
        }
      })
    })
    return decisions
  } catch (err) {
    logJev({
      ...context,
      status: 'fallback',
      reason: err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')
        ? 'timeout'
        : 'evaluation-error',
      durationMs: Date.now() - started
    })
    throw err
  }
}

const VERDICT_TIMEOUT_MS = 2000

/**
 * Step-verdict question. Logs at JEV_CONFIDENCE=0.85 clustered mid-band
 * (~0.20–0.83) under a vague pass/fail ask; this wording pushes clear
 * outcomes toward the extremes so Farol can override the exit code, and
 * reserves middling scores for transcripts with no usable signal.
 */
const VERDICT_QUESTION: JevBooleanQuestion = {
  type: 'boolean',
  instructions:
    'Did this Farol pipeline step pass? Judge only the step transcript. ' +
    'AI steps often exit 0 even when the review failed — ignore process/exit framing. ' +
    'When the transcript clearly passes or clearly fails, answer near 1.0 or near 0.0. ' +
    'Use a mid probability only when there is no usable pass/fail signal.',
  criteria: {
    true:
      'explicit pass/success/ok/approved, or clean results with no blocking findings ' +
      'and no required fixes',
    false:
      'explicit fail/error/rejected, blocking findings, unresolved issues the step was ' +
      'meant to catch, or required fixes before the change can proceed'
  }
}

/**
 * Runner's fallback for an AI pipeline step that exits without a
 * `FAROL_VERDICT` line. Fails soft to `null` — no key, a slow gateway, or an
 * inconclusive read all fall through to it — so the runner keeps using the
 * process's raw exit code exactly as it did before Jev existed.
 */
export async function verdictFromOutput(output: string): Promise<StepVerdict | null> {
  try {
    const { passed } = await askJev(output, { passed: VERDICT_QUESTION }, {
      timeoutMs: VERDICT_TIMEOUT_MS,
      purpose: 'step-verdict'
    })
    return passed === true ? 'pass' : passed === false ? 'fail' : null
  } catch {
    return null
  }
}

const SELECTION_TIMEOUT_MS = 2000

function asChoiceAnswer(raw: unknown): JevChoiceAnswer | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const answer = raw as { type?: string; choice?: string; probabilities?: Record<string, number> }
  if (answer.type !== 'choice' || typeof answer.choice !== 'string') return undefined
  return {
    type: 'choice',
    choice: answer.choice,
    ...(answer.probabilities ? { probabilities: answer.probabilities } : {})
  }
}

/**
 * Ask Jev which one opted-in, non-mandatory candidate to add this turn (or
 * `none`). Soft-fail only: `null` on no key, a slow gateway, or an error means
 * "Jev added nothing," never "run none of these" — the agent's own
 * `FAROL_PIPELINES` selection and the mandatory merge are unaffected either
 * way. Ids come back only from host-prepared candidates, so an invented id is
 * impossible.
 */
export async function selectPipelines(
  candidates: Pipeline[],
  state: string,
  opts: { attempt?: number } = {}
): Promise<string[] | null> {
  const prep = preparePipelineChoice(candidates)
  const questions = pipelineSelectionQuestions(candidates)
  const started = Date.now()
  const base = {
    timestamp: new Date(started).toISOString(),
    purpose: 'pipeline-selection' as const,
    model: JEV_MODEL_ID,
    threshold: JEV_SELECTION_THRESHOLD,
    candidateCount: prep?.candidates.length ?? 0,
    candidates: (prep?.candidates ?? []).map((pipeline) => ({ id: pipeline.id, name: pipeline.name })),
    candidatesFingerprint: prep?.fingerprint,
    stateChars: state.length,
    ...(opts.attempt !== undefined ? { attempt: opts.attempt } : {})
  }
  if (!prep || !Object.keys(questions).length) {
    logJev({ ...base, status: 'skipped', reason: 'no-candidates' })
    return null
  }
  const key = peekSecret('aiGatewayApiKey')
  if (!key) {
    logJev({ ...base, status: 'skipped', reason: 'no-key' })
    return null
  }
  try {
    const { answers } = await evaluate({
      model: createGateway({ apiKey: key }).evaluationModel(JEV_MODEL_ID),
      state,
      questions,
      abortSignal: AbortSignal.timeout(SELECTION_TIMEOUT_MS)
    })
    const answer = asChoiceAnswer(answers.pipeline)
    const selectedId = acceptPreparedChoice(answer, prep.preparedIds, {
      fingerprint: prep.fingerprint,
      currentFingerprint: prep.fingerprint,
      threshold: JEV_SELECTION_THRESHOLD
    })
    const probability = answer ? choiceProbability(answer) ?? null : null
    let reason:
      | 'selected'
      | 'not-selected'
      | 'none'
      | 'missing-answer'
      | 'unknown-id'
      | 'low-confidence'
      | 'stale-candidates' = 'missing-answer'
    let selected: string[] = []
    if (!answer) {
      reason = 'missing-answer'
    } else if (!prep.preparedIds.includes(answer.choice)) {
      reason = 'unknown-id'
    } else if (
      probability !== undefined &&
      probability !== null &&
      probability < JEV_SELECTION_THRESHOLD
    ) {
      reason = 'low-confidence'
    } else if (selectedId === PIPELINE_NONE_ID) {
      reason = 'none'
    } else if (selectedId) {
      reason = 'selected'
      selected = [selectedId]
    } else {
      reason = 'not-selected'
    }
    logJev({
      ...base,
      status: 'evaluated',
      durationMs: Date.now() - started,
      selected,
      choice: answer?.choice ?? null,
      probability,
      decisions: prep.candidates.map((pipeline) => ({
        id: pipeline.id,
        probability: answer?.probabilities?.[pipeline.id] ?? null,
        decision: selected.includes(pipeline.id),
        reason: selected.includes(pipeline.id) ? ('selected' as const) : ('not-selected' as const)
      })),
      outcome: reason
    })
    return selected
  } catch (err) {
    logJev({
      ...base,
      status: 'fallback',
      reason: err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')
        ? 'timeout'
        : 'evaluation-error',
      durationMs: Date.now() - started
    })
    return null
  }
}

/**
 * Ask Jev which host-prepared tool focus this turn needs.
 *
 * Build: soft-fail `null` → controller maps to `fallback-full`.
 * Plan: Choice is only among read-only foci; soft-fail returns inspect so
 * optional families never open up.
 */
export async function selectTools(
  state: string,
  opts: { attempt?: number; mode?: 'plan' | 'build' } = {}
): Promise<ToolSelection | null> {
  const mode = opts.mode ?? 'build'
  const questions = toolSelectionQuestions(mode)
  const fingerprint = toolFocusFingerprint(mode)
  const started = Date.now()
  const base = {
    timestamp: new Date(started).toISOString(),
    purpose: 'tool-selection' as const,
    model: JEV_MODEL_ID,
    confidence: JEV_TOOL_CONFIDENCE,
    mode,
    questionIds: Object.keys(questions),
    candidatesFingerprint: fingerprint,
    stateChars: state.length,
    ...(opts.attempt !== undefined ? { attempt: opts.attempt } : {})
  }
  const key = peekSecret('aiGatewayApiKey')
  if (!key) {
    logJev({ ...base, status: 'skipped', reason: 'no-key' })
    return mode === 'plan' ? defaultPlanSelection() : null
  }
  try {
    const { answers } = await evaluate({
      model: createGateway({ apiKey: key }).evaluationModel(JEV_MODEL_ID),
      state,
      questions,
      abortSignal: AbortSignal.timeout(TOOL_SELECTION_TIMEOUT_MS)
    })
    const answer = asChoiceAnswer(answers.focus)
    const selection = selectionFromChoice(answer, {
      mode,
      fingerprint,
      currentFingerprint: fingerprint,
      threshold: JEV_TOOL_CONFIDENCE
    })
    const probability = answer ? choiceProbability(answer) ?? null : null
    if (!selection) {
      const fallback = mode === 'plan' ? defaultPlanSelection() : null
      logJev({
        ...base,
        status: 'evaluated',
        durationMs: Date.now() - started,
        choice: answer?.choice ?? null,
        probability,
        kept: null,
        omitted: null,
        outcome: !answer
          ? 'missing-answer'
          : probability !== null && probability < JEV_TOOL_CONFIDENCE
            ? 'low-confidence'
            : 'unknown-id',
        ...(fallback ? { focus: fallback.focus, softFail: 'plan-inspect' } : {})
      })
      return fallback
    }
    logJev({
      ...base,
      status: 'evaluated',
      durationMs: Date.now() - started,
      choice: selection.kind === 'fallback-full' ? null : selection.focus,
      probability,
      kept: selection.kind === 'selected' ? selection.kept : selection.kind === 'plan' ? allowedForPlanFocus(selection.focus) : null,
      omitted:
        selection.kind === 'selected'
          ? selection.omitted
          : selection.kind === 'plan'
            ? omittedForPlanFocus(selection.focus)
            : null,
      outcome: 'selected'
    })
    return selection
  } catch (err) {
    logJev({
      ...base,
      status: 'fallback',
      reason: err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')
        ? 'timeout'
        : 'evaluation-error',
      durationMs: Date.now() - started,
      ...(mode === 'plan' ? { softFail: 'plan-inspect' } : {})
    })
    return mode === 'plan' ? defaultPlanSelection() : null
  }
}

/** `loadSettings` re-reads the key store, so it already carries the new flag. */
async function result(error?: string): Promise<SettingsResult> {
  return { settings: await loadSettings(), ...(error ? { error } : {}) }
}

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err))

/** Run the known-answer probe. No error means the key works and Jev agreed. */
export async function checkJev(): Promise<SettingsResult> {
  try {
    const answers = await askJev(JEV_PROBE.state, JEV_PROBE.questions, { purpose: 'settings-probe' })
    return result(
      answers.failed === true ? undefined : 'Jev answered the check question wrong. Try again.'
    )
  } catch (err) {
    return result(message(err))
  }
}

export async function saveJevKey(raw: unknown): Promise<SettingsResult> {
  if (typeof raw !== 'string' || !raw.trim()) return result(NO_KEY)
  try {
    setSecret('aiGatewayApiKey', raw)
  } catch (err) {
    return result(message(err))
  }
  return checkJev()
}

export async function clearJev(): Promise<SettingsResult> {
  clearSecret('aiGatewayApiKey')
  return result()
}
