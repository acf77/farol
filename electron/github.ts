import { execCli } from './exec-cli'
import type { GitHubInfo, PullRequest } from '../shared/types'

const GH_TIMEOUT = 30_000

type GhPr = {
  number: number
  mergeable?: string
}

export function noPullRequestMessage(text: string): boolean {
  return /no pull requests found/i.test(text)
}

function parsePr(raw: GhPr): PullRequest {
  return {
    number: raw.number,
    hasConflicts: raw.mergeable === 'CONFLICTING'
  }
}

/** Open PR for the current branch, if any — used only for merge-conflict status. */
export async function githubInfo(cwd: string): Promise<GitHubInfo> {
  const version = await execCli('gh', cwd, ['--version'], GH_TIMEOUT)
  if (version.code !== 0) {
    return { available: false, message: 'Install the GitHub CLI (gh) to check pull request conflicts.', prs: [] }
  }

  const auth = await execCli('gh', cwd, ['auth', 'status'], GH_TIMEOUT)
  if (auth.code !== 0) {
    return { available: false, message: 'Run `gh auth login` to check pull request conflicts.', prs: [] }
  }

  const view = await execCli(
    'gh',
    cwd,
    ['pr', 'view', '--json', 'number,mergeable'],
    GH_TIMEOUT
  )
  if (view.code !== 0) {
    const text = (view.err || view.out).trim()
    if (noPullRequestMessage(text)) return { available: true, prs: [] }
    const message = text.split('\n')[0] || 'could not read pull request'
    return { available: false, message, prs: [] }
  }

  try {
    const raw = JSON.parse(view.out) as GhPr
    return { available: true, prs: [parsePr(raw)] }
  } catch {
    return { available: false, message: 'Unexpected response from gh pr view', prs: [] }
  }
}
