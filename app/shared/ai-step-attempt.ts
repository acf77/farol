import { providerFailure } from './provider-failure'
import type { StepVerdict } from './verdict'

export type AiAttemptResult = { exit: number; verdict: StepVerdict | null; output: string }

/** Final exit for one fallback rung, or null when the chain should continue. */
export function resolveAiStepAttempt(
  result: AiAttemptResult,
  rungIndex: number,
  chainLength: number
): number | null {
  if (result.verdict === 'pass') return 0
  if (result.verdict === 'fail') return 1
  const providerReason = providerFailure(result.output)
  if (result.exit === 127 || providerReason) {
    if (rungIndex >= chainLength - 1) return result.exit === 127 ? 127 : 1
    return null
  }
  return result.exit
}
