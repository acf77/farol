import path from 'path'
import { formatGitStatus, parseGitAction, type GitAction, type GitActionResult } from '../shared/git-action'
import { isSecretPath } from '../shared/git-status'
import { gitArgs, gitNamesArgs } from '../shared/git-step'
import { execCli } from './exec-cli'
import { isInside, realPath } from './confine'
import { alone, commitAll, info as gitInfo, push, refusal, repoRoot, status, type GitScope } from './git'
import { createPullRequest } from './github'

/**
 * Perform one Git action for an agent, the way the Git panel would. Commit and push go
 * through git, so a Git hook pipeline gates them like it gates the panel's own; pull
 * requests go through GitHub. Callers decide whether Git actions are switched on.
 *
 * An agent may work in a subfolder of its checkout, but git names changed files from the
 * top of the repository and reads the paths it is given from the folder it runs in. So every
 * action starts at the top of the repository.
 */

/**
 * Whether the repository whose top folder is `root` belongs to `checkout`: it is the checkout's
 * own repository (which sits above the checkout when that is a subfolder), or one nested inside.
 * A caller that confined its folder to the checkout by where the folder really is gets the same
 * answer from git; this checks git's answer too, so an action never reaches another repository.
 */
async function ownsRepo(checkout: string, root: string): Promise<boolean> {
  const home = await realPath(checkout)
  if (!home) return false
  const own = await repoRoot(home)
  const top = path.resolve(root)
  return isInside(home, top) || (own !== undefined && path.resolve(own) === top)
}

async function commit(root: string, message: string, files: string[], scope?: GitScope): Promise<GitActionResult> {
  if (!files.length) return { ok: false, message: 'There are no files to commit: this turn changed none.' }
  const done = await commitAll(root, message, files, scope)
  if (!done.ok) {
    return { ok: false, message: done.error || 'Commit failed', ...(done.hookRun ? { hookRun: done.hookRun } : {}) }
  }
  const count = `${files.length} file${files.length === 1 ? '' : 's'}`
  return { ok: true, message: `Committed ${count}: ${(done.message ?? message).split('\n')[0]}` }
}

const SHOW = ['show', '--no-color', '--no-ext-diff', '--no-textconv', '--no-renames']
const READ_LIMIT = 40_000

const readGit = (root: string, args: string[]) =>
  execCli('git', root, ['--no-pager', ...args], 10_000, { GIT_OPTIONAL_LOCKS: '0' })

/** The files a diff or a show reads, or undefined for a log, which prints no file content. */
function readNames(request: GitAction): string[] | undefined {
  if (request.action === 'show') return [...SHOW, '--name-only', '--format=', '-z', request.ref, '--']
  return request.action === 'diff' ? gitNamesArgs({ op: 'diff' }) : undefined
}

/**
 * A diff, log or show. A tracked .env or key must not reach the agent's prompt, so such files
 * are left out of the patch, as in a diff step.
 */
async function readAction(root: string, request: GitAction): Promise<GitActionResult> {
  const names = readNames(request)
  const listed = names && (await readGit(root, names))
  if (listed && listed.code !== 0) return { ok: false, message: listed.err || 'No output.' }
  const hidden = (listed ? listed.out.split('\0') : []).filter(isSecretPath)
  const excluded = hidden.map((p) => `:(top,exclude,literal)${p}`)
  const result = await readGit(
    root,
    request.action === 'show' ? [...SHOW, request.ref, '--', ...excluded] : gitArgs({ op: request.action }, hidden)
  )
  const output = result.code === 0 ? result.out : result.err
  const cut = output.length > READ_LIMIT ? `${output.slice(0, READ_LIMIT)}\n[Output cut at ${READ_LIMIT} characters.]` : output
  return { ok: result.code === 0, message: cut || 'No output.' }
}

/**
 * `checkout` is the folder whose repository the action may touch; any other repository is refused, and so is an unknown checkout.
 * `scope` is what the actions of one turn hold fixed: a commit, a push or a pull request does not go on once the turn was
 * stopped, or the checkout is no longer on the branch the turn began on. Status only reads, so it ignores the scope.
 */
export async function performGitAction(
  cwd: string,
  request: GitAction,
  checkout: string,
  scope?: GitScope
): Promise<GitActionResult> {
  const parsed = parseGitAction(request)
  if ('error' in parsed) return { ok: false, message: parsed.error }
  request = parsed
  const root = await repoRoot(cwd)
  if (!root) return { ok: false, message: 'This folder is not in a Git repository.' }
  if (!(await ownsRepo(checkout, root))) {
    return { ok: false, message: 'This folder is in a repository that is not part of the open project.' }
  }
  switch (request.action) {
    case 'diff':
    case 'log':
    case 'show':
      return readAction(root, request)
    case 'status': {
      const [st, git] = await Promise.all([status(root), gitInfo(root)])
      return { ok: true, message: formatGitStatus(git.branch, st) }
    }
    case 'commit':
      return commit(root, request.message, request.files ?? [], scope)
    case 'push':
      return push(root, scope)
    case 'create_pr':
      // It takes its turn on the checkout like a commit or a push, and is refused in that turn the same way.
      return alone(root, async () => {
        const refused = await refusal(root, scope)
        if (refused) return { ok: false, message: refused }
        const { ok, message } = await createPullRequest(root, request.base, request.title, request.body)
        return { ok, message }
      })
  }
}
