import path from 'path'
import { formatGitStatus, type GitAction, type GitActionResult } from '../shared/git-action'
import { isInside, realPath } from './confine'
import { alone, commitAll, info as gitInfo, push, refusal, repoRoot, status, type GitScope } from './git'
import { createPullRequest } from './github'

/** Agent Git actions; commit/push use git hooks, PRs use GitHub. Actions run from repo root. */

/** Whether `root` is the checkout repo or a nested repo inside it. */
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

/** One action; `scope` pins branch/tree for mutating actions. */
export async function performGitAction(
  cwd: string,
  request: GitAction,
  checkout: string,
  scope?: GitScope
): Promise<GitActionResult> {
  const root = await repoRoot(cwd)
  if (!root) return { ok: false, message: 'This folder is not in a Git repository.' }
  if (!(await ownsRepo(checkout, root))) {
    return { ok: false, message: 'This folder is in a repository that is not part of the open project.' }
  }
  switch (request.action) {
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
