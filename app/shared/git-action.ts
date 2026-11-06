/**
 * Git actions an agent asks Farol to perform instead of running git itself: status,
 * commit, push, and open a pull request. Farol does them inside the app, so a Git hook
 * pipeline can gate them and the Git panel shows them. Managed Chat asks with a
 * `FAROL_GIT:` line; any other agent uses the matching MCP tool.
 */

import { GIT_MARKER, allControlLines } from './control-line'
import type { GitActionEvent, GitHookRun, GitStatus } from './types'

export type GitAction =
  | { action: 'status' }
  /** `files`: the paths to commit. Managed Chat ignores it and commits the files the turn changed. */
  | { action: 'commit'; message: string; files?: string[] }
  | { action: 'push' }
  | { action: 'create_pr'; base?: string; title?: string; body?: string }

export interface GitActionResult {
  ok: boolean
  /** What the agent is told. */
  message: string
  /** The hooks that blocked a commit or push, with their output: the agent can repair what they report. */
  hookRun?: GitHookRun
  /** Farol did not try, and asking again cannot help: the Git actions switch is off, the folder is in no project the app has open, or another chat worked in the checkout. */
  refused?: true
}

/** What an action says when it did not go on, because the checkout left the branch its turn began on. */
export const branchMoved = (from: string | undefined, to: string | undefined): string =>
  `The checkout moved from ${from ?? 'no branch'} to ${to ?? 'no branch'}, so Farol did not go on.`

/** What a commit says when files are no longer as validation saw them: it commits only what was checked. */
export const staleFilesMessage = (files: string[]): string =>
  `These files changed after validation, so Farol did not commit: ${files.slice(0, 5).join(', ')}${files.length > 5 ? `, and ${files.length - 5} more` : ''}.`

const text = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() ? value.trim() : undefined

const optional = <K extends string>(key: K, value: string | undefined): Partial<Record<K, string>> =>
  value ? ({ [key]: value } as Record<K, string>) : {}

/** A request from a `FAROL_GIT` line or the bridge, checked; anything else is an error the agent can read. */
export function parseGitAction(value: unknown): GitAction | { error: string } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { error: 'A Git action is one JSON object, for example { "action": "commit", "message": "…" }.' }
  }
  const raw = value as Record<string, unknown>
  switch (raw.action) {
    case 'status':
      return { action: 'status' }
    case 'push':
      return { action: 'push' }
    case 'commit': {
      const message = text(raw.message)
      if (!message) return { error: 'A commit needs a non-empty "message".' }
      const files = Array.isArray(raw.files) ? raw.files.filter((file): file is string => typeof file === 'string') : []
      return { action: 'commit', message, ...(files.length ? { files } : {}) }
    }
    case 'create_pr':
      return {
        action: 'create_pr',
        ...optional('base', text(raw.base)),
        ...optional('title', text(raw.title)),
        ...optional('body', text(raw.body))
      }
    default:
      return { error: `Unknown Git action ${JSON.stringify(raw.action)}; use status, commit, push or create_pr.` }
  }
}

/**
 * The Git actions a reply asks for, in order, and what was wrong with the lines that were not understood.
 * A line repeated word for word counts once: a chat can report the same text twice.
 */
export function gitActionsFrom(control: string): { actions: GitAction[]; errors: string[] } {
  const actions: GitAction[] = []
  const errors: string[] = []
  for (const raw of new Set(allControlLines(control, GIT_MARKER))) {
    let value: unknown
    try {
      value = JSON.parse(raw)
    } catch {
      errors.push(`The value after ${GIT_MARKER} must be one JSON object.`)
      continue
    }
    const parsed = parseGitAction(value)
    if ('error' in parsed) errors.push(parsed.error)
    else actions.push(parsed)
  }
  return { actions, errors }
}

const MAX_LISTED_FILES = 40

/** The branch, how it relates to its remote, and the files that changed, in a few lines an agent can read. */
export function formatGitStatus(branch: string, status: GitStatus): string {
  const unpushed = `${status.ahead} unpushed commit${status.ahead === 1 ? '' : 's'}`
  const remote = status.upstream
    ? `${status.ahead} ahead and ${status.behind} behind its remote branch`
    : status.remote
      ? `not published to ${status.remote} (${unpushed})`
      : 'no remote'
  const seen = new Set<string>()
  const files = [...status.conflicts, ...status.staged, ...status.unstaged, ...status.untracked].filter((file) => {
    if (seen.has(file.path)) return false
    seen.add(file.path)
    return true
  })
  const lines = files.slice(0, MAX_LISTED_FILES).map((file) => `  ${file.kind}: ${file.path}`)
  if (files.length > MAX_LISTED_FILES) lines.push(`  …and ${files.length - MAX_LISTED_FILES} more`)
  return [
    `Branch ${branch}: ${remote}.`,
    status.clean ? 'Working tree is clean.' : `${files.length} changed file${files.length === 1 ? '' : 's'}:`,
    ...lines
  ].join('\n')
}

const LABELS: Record<GitActionEvent['action'], string> = {
  status: 'status',
  commit: 'commit',
  push: 'push',
  create_pr: 'pull request'
}

/** The Git log's name for an action. */
export const gitActionLabel = (action: GitActionEvent['action']): string => `Agent ${LABELS[action]}`

/** What an agent is told about a finished action, with the output of any hook that blocked it. */
export function formatGitResult(action: GitAction['action'], result: GitActionResult): string {
  const outcome = result.ok ? 'done' : result.refused ? 'refused' : 'failed'
  const head = `Git ${LABELS[action]} ${outcome}: ${result.message}`
  if (!result.hookRun) return head
  return `${head}\nBlocked by ${result.hookRun.hooks.join(', ')}. Its output:\n${result.hookRun.output}`
}
