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
import { decide, JEV_MODEL_ID, JEV_PROBE, type JevBooleanQuestion } from '../shared/jev'
import type { SettingsResult } from '../shared/types'
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
  questions: Record<string, JevBooleanQuestion>
): Promise<Record<string, boolean | null>> {
  const key = peekSecret('aiGatewayApiKey')
  if (!key) throw new Error(NO_KEY)
  const { answers } = await evaluate({
    model: createGateway({ apiKey: key }).evaluationModel(JEV_MODEL_ID),
    state,
    questions
  })
  return Object.fromEntries(Object.entries(answers).map(([id, a]) => [id, decide(a)]))
}

/** `loadSettings` re-reads the key store, so it already carries the new flag. */
async function result(error?: string): Promise<SettingsResult> {
  return { settings: await loadSettings(), ...(error ? { error } : {}) }
}

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err))

/** Run the known-answer probe. No error means the key works and Jev agreed. */
export async function checkJev(): Promise<SettingsResult> {
  try {
    const answers = await askJev(JEV_PROBE.state, JEV_PROBE.questions)
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
