/**
 * What `GET /v1/runs/:id` returns: the contract between the run service and any
 * app that starts a run. Bump `schema` on any change a client could trip over;
 * adding an optional field is not one.
 */

export const RUN_RESULT_SCHEMA = 1

export type RunResultStatus = 'running' | 'passed' | 'failed' | 'cancelled'

/**
 * `needs-local`: an AI step stopped because credits ran out. Not a code failure; run it locally.
 * The Farol API already sends it under schema 1 (farol/api internal/runs/result.go), so this type
 * follows the server and the schema stays 1. A client that does not know the value must treat it as not passed.
 */
export type RunStepStatus = 'pending' | 'running' | 'passed' | 'failed' | 'skipped' | 'needs-local'

export interface RunResultStep {
  id: string
  name: string
  status: RunStepStatus
  /** Set once the step has ended and was not skipped. */
  exitCode?: number
  durationMs?: number
  /** The end of the step's output, at most `RUN_STEP_OUTPUT_LIMIT` characters. Untrusted text. */
  output: string
  /** The step printed more than `output` holds. */
  outputTruncated: boolean
}

export interface RunResult {
  schema: typeof RUN_RESULT_SCHEMA
  runId: string
  status: RunResultStatus
  /** What ran: the uploaded snapshot, by content hash. */
  source: { kind: 'snapshot'; sha256: string; bytes: number }
  pipeline: { id: string; name: string }
  createdAt: string
  finishedAt?: string
  /** The first step that failed. */
  failedStepId?: string
  /** Why the run could not go on, e.g. the sandbox did not start or the time limit hit. */
  error?: string
  /** In pipeline order. */
  steps: RunResultStep[]
}

export const RUN_STEP_OUTPUT_LIMIT = 64_000
