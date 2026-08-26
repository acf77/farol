/** The failure report an agent reads. Pure, so it can be unit-tested. */

/** Where a failed run leaves its report, relative to the run's working copy. */
export const FAILURE_REPORT_REL = '.buildflow/last-failure.md'

/** How much of the failing step's output to keep, tail-first. */
export const REPORT_OUTPUT_LIMIT = 12000

export interface FailureReport {
  pipeline: string
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
 * Tell the agent how to check its own work, and where. Re-running the whole
 * pipeline is the real test — the failing command alone can pass while a later
 * step still breaks — so the MCP tool comes first, with the bare command as
 * the fallback for agents with no BuildFlow MCP server wired up.
 */
function verifySection(r: FailureReport): string[] {
  return [
    '## Verify your fix',
    '',
    `You are fixing the \`${r.step}\` step of the \`${r.pipeline}\` pipeline, on branch \`${r.branch}\` in \`${r.cwd}\`.`,
    'Confirm you are in that directory and on that branch before you start — a fix made in another worktree will not be exercised by the run below.',
    '',
    `1. Re-run the failing command above to iterate quickly on \`${r.step}\`.`,
    `2. Then re-run the whole pipeline: the \`buildflow\` MCP tool \`run_pipeline\` with pipeline \`${r.pipeline}\` (call \`list_pipelines\` first if you need the exact id). It executes in the BuildFlow window, so the user can watch it.`,
    '',
    'A green command is weaker evidence than a green pipeline: other steps may depend on what you changed. If that tool is not available to you, run the command directly and say so in your summary.',
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
 * The `.buildflow/.gitignore` needed to keep the report out of commits, or
 * null when it already covers it. Only the report file is ignored — the
 * pipelines in that same folder are meant to be committed.
 */
export function gitignoreWithEntry(current: string, entry: string): string | null {
  if (current.split('\n').some((line) => line.trim() === entry)) return null
  if (!current) return `${entry}\n`
  return current.endsWith('\n') ? `${current}${entry}\n` : `${current}\n${entry}\n`
}
