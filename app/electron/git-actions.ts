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
 * Returns the checkout's real path when the repository belongs to it.
 */
async function ownedHome(checkout: string, root: string): Promise<string | undefined> {
  const home = await realPath(checkout)
  if (!home) return undefined
  const own = await repoRoot(home)
  const top = path.resolve(root)
  return isInside(home, top) || (own !== undefined && path.resolve(own) === top) ? home : undefined
}

/** What an action may touch: the whole repository, or only the checkout when it is a subfolder of it. */
type Within = { home: string; root: string; spec: string[] }

function within(home: string, root: string): Within {
  const rel = path.relative(root, home)
  const sub = rel !== '' && isInside(root, home)
  return { home, root, spec: sub ? [`:(top,literal)${rel.split(path.sep).join('/')}`] : [] }
}

async function commit(at: Within, message: string, files: string[], scope?: GitScope): Promise<GitActionResult> {
  const { root } = at
  if (!files.length) return { ok: false, message: 'There are no files to commit: this turn changed none.' }
  if (files.some((file) => !isInside(at.home, path.resolve(root, file)))) {
    return { ok: false, message: 'A file to commit is outside the open project folder.' }
  }
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
function readNames(action: GitAction['action'], commitId?: string): string[] | undefined {
  if (commitId) return [...SHOW, '--name-only', '--format=', '-z', commitId, '--']
  return action === 'diff' ? gitNamesArgs({ op: 'diff' }) : undefined
}

/** The commit a show reads. A blob or tree id is refused: its name listing would print file contents. */
async function showCommit(root: string, ref: string): Promise<string | undefined> {
  const found = await readGit(root, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`])
  return found.code === 0 ? found.out.trim() : undefined
}

/**
 * A diff, log or show. A tracked .env or key must not reach the agent's prompt, so such files
 * are left out of the patch, as in a diff step.
 */
async function readAction({ root, spec }: Within, request: GitAction): Promise<GitActionResult> {
  const commitId = request.action === 'show' ? await showCommit(root, request.ref) : undefined
  if (request.action === 'show' && !commitId) return { ok: false, message: 'Git show needs a commit.' }
  const names = readNames(request.action, commitId)?.concat(spec)
  const listed = names && (await readGit(root, names))
  if (listed && listed.code !== 0) return { ok: false, message: listed.err || 'No output.' }
  const hidden = (listed ? listed.out.split('\0') : []).filter(isSecretPath)
  const excluded = hidden.map((p) => `:(top,exclude,literal)${p}`)
  const result = await readGit(
    root,
    commitId ? [...SHOW, commitId, '--', ...spec, ...excluded] : [...gitArgs({ op: request.action }, hidden), ...spec]
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
  const home = await ownedHome(checkout, root)
  if (!home) return { ok: false, message: 'This folder is in a repository that is not part of the open project.' }
  const at = within(home, root)
  switch (request.action) {
    case 'diff':
    case 'log':
    case 'show':
      return readAction(at, request)
    case 'status': {
      const [st, git] = await Promise.all([status(root), gitInfo(root)])
      return { ok: true, message: formatGitStatus(git.branch, st) }
    }
    case 'commit':
      return commit(at, request.message, request.files ?? [], scope)
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
