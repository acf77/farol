/** The failure report an agent reads. Pure, so it can be unit-tested. */

import { managedCatalogPipelineId } from './runtime'

/** Where a failed run leaves its report, relative to the run's working copy. */
export const FAILURE_REPORT_REL = '.farol/last-failure.md'

/** How much of the failing step's output to keep, tail-first. */
export const REPORT_OUTPUT_LIMIT = 12000

export interface FailureReport {
  pipeline: string
  /**
   * Runner slot or managed catalog id. The Verify marker always uses the
   * managed-Chat form (`…:managed-pipeline:…`); raw UI/MCP slots are mapped.
   */
  pipelineId?: string
  step: string
  branch: string
  /** The working copy the run happened in — a worktree has its own. */
  cwd: string
  cmd: string
  code: number
  output: string
}

/**
 * An exit code above 128 means a signal killed the process, not that the tool
 * reported problems. Worth spelling out: an agent told only "exit 134" goes
 * hunting for lint errors that were never printed, because the process died
 * before it could print them.
 */
function codeNote(code: number): string {
  if (code <= 128 || code > 192) return ''
  const signal = code - 128
  const known: Record<number, string> = {
    2: 'SIGINT — interrupted',
    6: 'SIGABRT — the process aborted; for Node this usually means it ran out of heap memory',
    9: 'SIGKILL — killed outright, often by the OS running out of memory',
    11: 'SIGSEGV — segmentation fault',
    15: 'SIGTERM — terminated'
  }
  const what = known[signal] ?? `signal ${signal}`
  return ` (killed by ${what}; the command crashed rather than reporting failures)`
}

/**
 * Tell the agent how to check its own work. Re-running the whole pipeline is
 * the real test — the failing command alone can pass while a later step still
 * breaks — so prefer Farol (managed Chat marker or MCP) over shelling the
 * step. Direct command is last-resort only when neither path exists.
 */
function verifySection(r: FailureReport): string[] {
  // Auto-fix → managed Chat; never embed a UI/MCP runner slot as the example.
  const catalogId = r.pipelineId ? managedCatalogPipelineId(r.pipelineId) : undefined
  const markerExample = catalogId
    ? `FAROL_PIPELINES: ${JSON.stringify([catalogId])}`
    : 'FAROL_PIPELINES: ["<pipeline-id-from-catalog>"]'
  return [
    '## Verify your fix',
    '',
    `You are fixing the \`${r.step}\` step of the \`${r.pipeline}\` pipeline, on branch \`${r.branch}\` in \`${r.cwd}\`.`,
    'Confirm you are in that directory and on that branch before you start — a fix made in another worktree will not be exercised by the run below.',
    '',
    `Do not re-run the failing command yourself when Farol is available. After you fix the errors, re-run the whole \`${r.pipeline}\` pipeline through Farol:`,
    `- In Farol managed Chat: end your response with \`${markerExample}\` (JSON array of catalog ids only; never shell the step cmd or invent a placeholder id).`,
    `- Elsewhere: call the \`farol\` MCP tool \`run_pipeline\` with pipeline \`${r.pipeline}\` (name or bare id from \`list_pipelines\` — not the managed Chat marker id). It executes in the Farol window, so the user can watch it.`,
    '- If neither managed Chat nor that MCP tool is available, run the failing command above and say so in your summary.',
    '',
    'A green single command is weaker evidence than a green pipeline: other steps may depend on what you changed.',
    ''
  ]
}

export function failureReport(r: FailureReport): string {
  return [
    '# Pipeline failure',
    '',
    `- Pipeline: ${r.pipeline}`,
    `- Step: ${r.step}`,
    `- Branch: ${r.branch}`,
    `- Working directory: ${r.cwd}`,
    `- Exit code: ${r.code}${codeNote(r.code)}`,
    '',
    `The \`${r.step}\` step ran this command, and it failed:`,
    '',
    '```sh',
    r.cmd,
    '```',
    '',
    '## Output',
    '',
    '```text',
    r.output.trim().slice(-REPORT_OUTPUT_LIMIT) || '(no output)',
    '```',
    '',
    ...verifySection(r)
  ].join('\n')
}

/**
 * The `.farol/.gitignore` needed to keep the report out of commits, or
 * null when it already covers it. Only the report file is ignored — the
 * pipelines in that same folder are meant to be committed.
 */
export function gitignoreWithEntry(current: string, entry: string): string | null {
  if (current.split('\n').some((line) => line.trim() === entry)) return null
  if (!current) return `${entry}\n`
  return current.endsWith('\n') ? `${current}${entry}\n` : `${current}\n${entry}\n`
}
