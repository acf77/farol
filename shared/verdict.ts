/** Marker AI pipeline steps emit so Farol can read pass/fail from prose. */
export const VERDICT_MARKER = 'FAROL_VERDICT:'

export type StepVerdict = 'pass' | 'fail'

/**
 * Read the last verdict line an AI step printed. Managed Chat uses its own
 * markers; this one is for pipeline `ai` steps whose CLIs usually exit 0 even
 * when the review fails.
 */
export function parseVerdict(output: string): StepVerdict | null {
  const marker = output.lastIndexOf(VERDICT_MARKER)
  if (marker < 0) return null
  const value = output
    .slice(marker + VERDICT_MARKER.length)
    .split(/\r?\n/, 1)[0]
    .trim()
    .toLowerCase()
  if (value === 'pass' || value === 'passed' || value === 'ok' || value === 'success') return 'pass'
  if (value === 'fail' || value === 'failed' || value === 'error' || value === 'no') return 'fail'
  return null
}

/** Appended to every pipeline AI prompt so the runner knows how to score the step. */
export function verdictPromptSuffix(): string {
  return [
    '',
    `When your review is complete, end with exactly one line:`,
    `${VERDICT_MARKER} pass — if the check passed, or ${VERDICT_MARKER} fail if it did not.`,
    'Use those exact words (`pass` or `fail`) after the marker.'
  ].join('\n')
}

/** Drop verdict control lines from streamed output shown in the run log. */
export function stripVerdictLine(text: string): string {
  return text
    .split(/\r?\n/)
    .filter((line) => !line.trim().startsWith(VERDICT_MARKER))
    .join('\n')
}
