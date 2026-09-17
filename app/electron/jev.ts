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
  decide,
  JEV_CONFIDENCE,
  JEV_MODEL_ID,
  JEV_PROBE,
  pipelineSelectionQuestions,
  type JevBooleanQuestion
} from '../shared/jev'
import type { Pipeline, SettingsResult } from '../shared/types'
import type { StepVerdict } from '../shared/verdict'
import { clearSecret, peekSecret, setSecret } from './secrets'
import { loadSettings } from './store'

const NO_KEY = 'Save a Vercel AI Gateway API key first.'

/**
 * Jev's read on `state`: one entry per question, `null` where Jev was not
 * confident enough for Farol to act on. Throws when no key is stored or the
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
    console.info('[farol] Jev', { ...context, status: 'skipped', reason: 'no-key' })
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
      Object.keys(questions).map((id) => [id, answers[id] ? decide(answers[id]) : null])
    )
    console.info('[farol] Jev', {
      ...context,
      status: 'evaluated',
      durationMs: Date.now() - started,
      decisions: Object.entries(decisions).map(([id, decision]) => ({
        id,
        probability: answers[id]?.probability ?? null,
        decision,
        reason: !answers[id] ? 'missing-answer' : decision === null ? 'inconclusive' : 'confident'
      }))
    })
    return decisions
  } catch (err) {
    console.info('[farol] Jev', {
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

const VERDICT_QUESTION: JevBooleanQuestion = {
  type: 'boolean',
  instructions: "Given this pipeline step's output, did the check pass?",
  criteria: {
    true: 'the output reports success with no unresolved errors',
    false: 'the output reports a failure, error, or unresolved issue'
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

/**
 * Ask Jev which of the non-mandatory `candidates` should run this turn.
 * Additive and soft-fail only: `null` on no key, a slow gateway, or an error
 * means "Jev added nothing," never "run none of these" — the agent's own
 * `FAROL_PIPELINES` selection and the mandatory merge are unaffected either
 * way. Ids come back only from `candidates`, so an invented id is impossible.
 */
export async function selectPipelines(candidates: Pipeline[], state: string): Promise<string[] | null> {
  const questions = pipelineSelectionQuestions(candidates)
  const ids = Object.keys(questions)
  if (!ids.length) {
    console.info('[farol] Jev', {
      timestamp: new Date().toISOString(),
      purpose: 'pipeline-selection',
      status: 'skipped',
      reason: 'no-candidates'
    })
    return null
  }
  try {
    const answers = await askJev(state, questions, {
      timeoutMs: SELECTION_TIMEOUT_MS,
      purpose: 'pipeline-selection'
    })
    return ids.filter((id) => answers[id] === true)
  } catch {
    return null
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
