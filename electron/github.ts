import { execCli } from './exec-cli'
import type { GitHubInfo, PullRequest } from '../shared/types'

const GH_TIMEOUT = 30_000

type GhCheckContext = {
  context?: string
  state?: string
}

type GhCheckRollup = {
  state?: string
  contexts?: GhCheckContext[]
}

type GhPr = {
  number: number
  title: string
  url: string
  headRefName: string
  mergeable?: string
  statusCheckRollup?: GhCheckRollup
}

export function mapCheckState(state: string | undefined): 'pending' | 'pass' | 'fail' | 'skip' {
  const s = (state || '').toUpperCase()
  if (s === 'SUCCESS' || s === 'COMPLETED') return 'pass'
  if (s === 'FAILURE' || s === 'ERROR' || s === 'CANCELLED') return 'fail'
  if (s === 'SKIPPED' || s === 'NEUTRAL') return 'skip'
  return 'pending'
}

export function rollupCounts(rollup: GhCheckRollup | undefined): {
  hasChecks: boolean
  checksFailed: number
  checksPending: number
} {
  if (!rollup?.contexts?.length) {
    if (!rollup?.state) return { hasChecks: false, checksFailed: 0, checksPending: 0 }
    const status = mapCheckState(rollup.state)
    return {
      hasChecks: true,
      checksFailed: status === 'fail' ? 1 : 0,
      checksPending: status === 'pending' ? 1 : 0
    }
  }
  let checksFailed = 0
  let checksPending = 0
  for (const c of rollup.contexts) {
    const status = mapCheckState(c.state)
    if (status === 'fail') checksFailed++
    else if (status === 'pending') checksPending++
  }
  return { hasChecks: true, checksFailed, checksPending }
}

function parsePr(raw: GhPr): PullRequest {
  const { hasChecks, checksFailed, checksPending } = rollupCounts(raw.statusCheckRollup)
  return {
    number: raw.number,
    title: raw.title,
    url: raw.url,
    headRef: raw.headRefName,
    hasConflicts: raw.mergeable === 'CONFLICTING',
    hasChecks,
    checksPending,
    checksFailed
  }
}

/** Open PRs for the current branch's repo, plus required-check rollup when gh is available. */
export async function githubInfo(cwd: string): Promise<GitHubInfo> {
  const version = await execCli('gh', cwd, ['--version'], GH_TIMEOUT)
  if (version.code !== 0) {
    return { available: false, message: 'Install the GitHub CLI (gh) to see pull requests and checks.', prs: [] }
  }

  const auth = await execCli('gh', cwd, ['auth', 'status'], GH_TIMEOUT)
  if (auth.code !== 0) {
    return { available: false, message: 'Run `gh auth login` to connect GitHub.', prs: [] }
  }

  const list = await execCli(
    'gh',
    cwd,
    [
      'pr',
      'list',
      '--state',
      'open',
      '--json',
      'number,title,url,headRefName,mergeable,statusCheckRollup',
      '--limit',
      '20'
    ],
    GH_TIMEOUT
  )
  if (list.code !== 0) {
    const message = (list.err || list.out).trim().split('\n')[0] || 'could not list pull requests'
    return { available: false, message, prs: [] }
  }

  try {
    const raw = JSON.parse(list.out) as GhPr[]
    return { available: true, prs: raw.map(parsePr) }
  } catch {
    return { available: false, message: 'Unexpected response from gh pr list', prs: [] }
  }
}
