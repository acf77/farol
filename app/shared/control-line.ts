/**
 * Farol's hidden control lines: one line, one marker, one value. Parsing,
 * rendering, and stripping share this definition so a marker that appears in
 * prose or a code example is never mistaken for an instruction.
 */

export const QUESTIONS_MARKER = 'FAROL_QUESTIONS:'
export const PIPELINES_MARKER = 'FAROL_PIPELINES:'
export const BLOCK_MARKER = 'FAROL_BLOCKED:'
export const PLAN_MARKER = 'FAROL_PLAN:'
export const TODOS_MARKER = 'FAROL_TODOS:'
export const FINISHED_PLAN = `${PLAN_MARKER} finished`

export const CONTROL_MARKERS = [
  PIPELINES_MARKER,
  QUESTIONS_MARKER,
  BLOCK_MARKER,
  PLAN_MARKER,
  TODOS_MARKER
] as const

type ControlMarker = (typeof CONTROL_MARKERS)[number]

/** The value after the last line-anchored `marker`, or undefined if absent. */
export function lastControlLine(text: string, marker: string): string | undefined {
  let value: string | undefined
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trimStart()
    if (trimmed.startsWith(marker)) value = trimmed.slice(marker.length).trim()
  }
  return value
}

/** The last line-anchored control line, or null when the text has none. */
export function lastControlMarkerLine(
  text: string
): { marker: ControlMarker; value: string } | null {
  let found: { marker: ControlMarker; value: string } | null = null
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trimStart()
    const marker = CONTROL_MARKERS.find((candidate) => trimmed.startsWith(candidate))
    if (marker) found = { marker, value: trimmed.slice(marker.length).trim() }
  }
  return found
}
