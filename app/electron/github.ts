import { execCli } from './exec-cli'
import type { GitHubInfo, PullRequest } from '../shared/types'

const GH_TIMEOUT = 30_000
const PR_CREATE_TIMEOUT = 120_000

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

/** Why gh cannot be used for `purpose`, or null when it is installed and logged in. */
async function ghBlockReason(cwd: string, purpose: string): Promise<string | null> {
  const version = await execCli('gh', cwd, ['--version'], GH_TIMEOUT)
  if (version.code !== 0) return `Install the GitHub CLI (gh) to ${purpose}.`
  const auth = await execCli('gh', cwd, ['auth', 'status'], GH_TIMEOUT)
  if (auth.code !== 0) return `Run \`gh auth login\` to ${purpose}.`
  return null
}

/** Open PR for the current branch, if any — used only for merge-conflict status. */
export async function githubInfo(cwd: string): Promise<GitHubInfo> {
  const blocked = await ghBlockReason(cwd, 'check pull request conflicts')
  if (blocked) return { available: false, message: blocked, prs: [] }

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

/**
 * Open a pull request for the current branch. `--fill` takes the title and body
 * from the branch's commits, and gh targets the repository's default base, so
 * this needs no input beyond the push the caller already made.
 */
export async function createPullRequest(cwd: string): Promise<{ ok: boolean; message: string }> {
  const blocked = await ghBlockReason(cwd, 'open pull requests')
  if (blocked) return { ok: false, message: blocked }

  const res = await execCli('gh', cwd, ['pr', 'create', '--fill'], PR_CREATE_TIMEOUT)
  // gh prints the new PR's URL on stdout and diagnostics on stderr.
  const lines = `${res.out}\n${res.err}`.split('\n').map((l) => l.trim()).filter(Boolean)
  if (res.code !== 0) {
    return { ok: false, message: lines[0] ?? 'Could not create the pull request' }
  }
  const url = lines.find((l) => /^https?:\/\//.test(l))
  return { ok: true, message: url ? `Pull request created: ${url}` : 'Pull request created' }
}
