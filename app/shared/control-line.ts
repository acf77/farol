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

export interface ControlLineState {
  control: string
  buffer: string
  fenced: boolean
}

export function isFenceLine(line: string): boolean {
  return /^(?:`{3,}|~{3,})/.test(line.trimStart())
}

export function isControlLine(line: string): boolean {
  const trimmed = line.trimStart()
  return CONTROL_MARKERS.some((marker) => trimmed.startsWith(marker))
}

export function appendControlLines(state: ControlLineState, chunk: string): void {
  const lines = `${state.buffer}${chunk}`.split(/\r?\n/)
  state.buffer = lines.pop() ?? ''
  for (const line of lines) {
    if (!state.fenced && isControlLine(line)) state.control += `${line}\n`
    if (isFenceLine(line)) state.fenced = !state.fenced
  }
}

export function flushControlLines(state: ControlLineState): void {
  if (!state.buffer) return
  if (!state.fenced && isControlLine(state.buffer)) state.control += state.buffer
  state.buffer = ''
}

export function lastNonEmptyLine(text: string): { line: string; fenced: boolean } | undefined {
  let last: { line: string; fenced: boolean } | undefined
  for (const entry of fencedLines(text)) {
    if (entry.line.trim()) last = entry
  }
  return last
}

/** Every line tagged with whether it sits inside a fenced code example. */
function fencedLines(text: string): { line: string; fenced: boolean }[] {
  const out: { line: string; fenced: boolean }[] = []
  let fenced = false
  for (const line of text.split(/\r?\n/)) {
    const fence = isFenceLine(line)
    out.push({ line, fenced: fenced || fence })
    if (fence) fenced = !fenced
  }
  return out
}

/** Lines outside fenced code blocks, where a marker is an instruction rather than an example. */
export function controlLines(text: string): string[] {
  return fencedLines(text)
    .filter(({ fenced }) => !fenced)
    .map(({ line }) => line)
}

/** The value after the last line-anchored `marker`, or undefined if absent. */
export function lastControlLine(text: string, marker: string): string | undefined {
  let value: string | undefined
  for (const line of controlLines(text)) {
    const trimmed = line.trimStart()
    if (isControlLine(line) && trimmed.startsWith(marker)) value = trimmed.slice(marker.length).trim()
  }
  return value
}

/** The last line-anchored control line, or null when the text has none. */
export function lastControlMarkerLine(
  text: string
): { marker: ControlMarker; value: string } | null {
  let found: { marker: ControlMarker; value: string } | null = null
  for (const line of controlLines(text)) {
    const trimmed = line.trimStart()
    const marker = isControlLine(line)
      ? CONTROL_MARKERS.find((candidate) => trimmed.startsWith(candidate))
      : undefined
    if (marker) found = { marker, value: trimmed.slice(marker.length).trim() }
  }
  return found
}

/** Drop line-anchored control markers while leaving fenced code examples intact. */
export function stripControlMarkerLines(text: string): string {
  return fencedLines(text)
    .filter(
      ({ line, fenced }) =>
        fenced || !isControlLine(line)
    )
    .map(({ line }) => line)
    .join('\n')
}
