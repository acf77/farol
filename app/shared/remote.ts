/** Pure pieces of remote pipeline runs: which files travel, and what to tell the user. */

import { isSecretPath } from './git-status'

/** Where the checkout snapshot is unpacked inside the sandbox. */
export const REMOTE_WORKDIR = '/vercel/sandbox/project'

/** A checkout larger than this is more likely a mistake than something to upload per run. */
export const SNAPSHOT_LIMIT_BYTES = 256 * 1024 * 1024

/** Sandboxes stop themselves even if Farol dies before cleaning up. */
export const SANDBOX_TIMEOUT_MS = 45 * 60_000

const BULK_MEDIA = /\.(mp3|wav|flac|aac|m4a|ogg|mp4|mov|m4v|webm|avi|mkv|pdf|psd|sketch|fig)$/i

/** Media and design files that no shell step needs and that dominate upload time. */
export function isBulkMedia(file: string): boolean {
  return BULK_MEDIA.test(file)
}

/**
 * The files a remote run receives, from NUL-separated `git ls-files --cached
 * --others --exclude-standard` output: tracked plus untracked-not-ignored, so
 * uncommitted work travels while ignored build output and secrets do not.
 * Audio, video, PDFs and design files stay behind too: steps are shell commands,
 * and a few of them can turn a snapshot into hundreds of megabytes to upload.
 */
export function snapshotPaths(gitOutput: string): string[] {
  const seen = new Set<string>()
  for (const file of gitOutput.split('\0')) {
    if (file && !isSecretPath(file) && !isBulkMedia(file)) seen.add(file)
  }
  return [...seen]
}

export function snapshotSummary(files: number, bytes: number): string {
  const mb = bytes / (1024 * 1024)
  const size = `${mb < 0.1 ? '<0.1' : mb.toFixed(1)} MB`
  if (files <= 0) return size
  return `${files} file${files === 1 ? '' : 's'}, ${size}`
}

/** What a content-addressed upload tells the user: how many files, and how much actually travelled. */
export function syncSummary(files: number, uploadedBytes: number): string {
  const count = `${files} file${files === 1 ? '' : 's'}`
  if (uploadedBytes <= 0) return `${count}, nothing new to send`
  const mb = uploadedBytes / (1024 * 1024)
  return `${count}, ${mb < 0.1 ? '<0.1' : mb.toFixed(1)} MB sent`
}

/** All a user is told about the remote service when they are not signed in. */
export const SIGN_IN_REQUIRED = 'Sign in to run remote pipelines.'
