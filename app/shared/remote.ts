/** Pure pieces of remote pipeline runs: which files travel, and what to tell the user. */

import { isSecretPath } from './git-status'

/** A started remote workspace: a sandbox that holds an uploaded checkout and runs its shell steps. */
export interface RemoteWorkspace {
  /** What was uploaded, e.g. `12 files, 0.4 MB`. */
  summary: string
  /** Run a shell step; resolves with its exit code. Output arrives with `\n` line ends. */
  exec(cmd: string, onChunk: (chunk: string) => void): Promise<number>
  /** Stop the sandbox. Safe to call more than once. */
  close(): Promise<void>
}

/** A checkout larger than this is more likely a mistake than something to upload per run. */
export const SNAPSHOT_LIMIT_BYTES = 256 * 1024 * 1024

/** Sandboxes stop themselves even if Farol dies before cleaning up. */
export const SANDBOX_TIMEOUT_MS = 45 * 60_000

/**
 * The files a remote run receives, from NUL-separated `git ls-files --cached
 * --others --exclude-standard` output: tracked plus untracked-not-ignored, so
 * uncommitted work travels while ignored build output and secrets do not.
 */
export function snapshotPaths(gitOutput: string): string[] {
  const seen = new Set<string>()
  for (const file of gitOutput.split('\0')) {
    if (file && !isSecretPath(file)) seen.add(file)
  }
  return [...seen]
}

export function snapshotSummary(files: number, bytes: number): string {
  const mb = bytes / (1024 * 1024)
  const size = `${mb < 0.1 ? '<0.1' : mb.toFixed(1)} MB`
  if (files <= 0) return size
  return `${files} file${files === 1 ? '' : 's'}, ${size}`
}

/** All a user is told about the remote service when they are not signed in. */
export const SIGN_IN_REQUIRED = 'Sign in to run remote pipelines.'
