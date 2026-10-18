import type { GitOp, Step } from './types'

/**
 * `git` steps run a fixed git command per op. The user picks the op, a ref and pathspecs,
 * never shell text: values are checked here and passed to git as arguments, never to a shell.
 */

export const GIT_OPS: readonly GitOp[] = ['diff', 'diff-stat', 'log', 'status', 'changed-files']

const REF_RE = /^[A-Za-z0-9._/-]{1,200}$/
const PATH_RE = /^[A-Za-z0-9._/*-]{1,200}$/
const MAX_PATHS = 32

/** Where the result of a git step is written, relative to the checkout. */
export const GIT_ARTIFACT_DIR = '.farol/git'

type GitStep = Pick<Step, 'op' | 'base' | 'paths'>

const pathList = (step: GitStep): string[] => (step.paths ?? []).filter(Boolean)

const safe = (value: string, re: RegExp): boolean => re.test(value) && !value.startsWith('-') && !value.includes('..')

/** Why a git step cannot run, or null. */
export function gitStepError(step: GitStep): string | null {
  if (!step.op || !GIT_OPS.includes(step.op)) return `git step needs one op: ${GIT_OPS.join(', ')}`
  if (step.base && !safe(step.base, REF_RE)) return 'git step base must be a plain ref, such as main'
  const paths = pathList(step)
  if (paths.length > MAX_PATHS) return `git step allows at most ${MAX_PATHS} paths`
  if (paths.some((p) => !safe(p, PATH_RE))) return 'git step paths may hold only letters, digits and . _ / * -'
  return null
}

/** No external diff drivers and no `textconv` filters, so a repo's git config cannot run commands. */
const DIFF = ['diff', '--no-color', '--no-ext-diff', '--no-textconv']

/**
 * The arguments for git. Call only after `gitStepError` returned null. `hidden` paths are left out,
 * and a diff does not pair renames, so a hidden path never shows up as the old name of another.
 */
export function gitArgs(step: GitStep, hidden: string[] = []): string[] {
  const { op, base } = step
  const limit = ['--', ...pathList(step), ...hidden.map((p) => `:(top,exclude,literal)${p}`)]
  const ref = base || 'HEAD'
  switch (op) {
    case 'diff-stat':
      return [...DIFF, '--stat', ref, ...limit]
    case 'changed-files':
      return [...DIFF, '--name-only', ref, ...limit]
    case 'log':
      return ['log', '--no-color', '--oneline', '-n', '50', base ? `${base}..HEAD` : 'HEAD', ...limit]
    case 'status':
      return ['status', '--short', '--branch', ...limit]
    default:
      return [...DIFF, '--no-renames', ref, ...limit]
  }
}

/** Arguments that print, NUL-separated, the files a `diff` step reads. */
export function gitNamesArgs(step: GitStep): string[] {
  return [...DIFF, '--no-renames', '--name-only', '-z', step.base || 'HEAD', '--', ...pathList(step)]
}

/** A one-line label for a git step, such as `git diff main *.go`. */
export function gitSummary(step: GitStep): string {
  return ['git', step.op, step.base, ...pathList(step)].filter(Boolean).join(' ')
}

/** The file for a step's result: `.farol/git/<pipeline>/<as or id>.patch` for a diff, `.txt` for the rest. */
export function gitArtifactPath(node: GitStep & { id: string; as?: string }, pipelineId: string): string {
  // `_` starts an escape (and is escaped itself), so different ids never share a name.
  const safe = (text: string): string => text.replace(/[^A-Za-z0-9-]/g, (c) => `_${c.codePointAt(0)!.toString(16)}_`)
  return `${GIT_ARTIFACT_DIR}/${safe(pipelineId)}/${safe(node.as ?? node.id)}.${node.op === 'diff' ? 'patch' : 'txt'}`
}
