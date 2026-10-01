import { execCli } from './exec-cli'
import { mergePullRequestBlockReason, summarizePrChecks } from '../shared/git-status'
import type {
  GitHubInfo,
  MergeStrategy,
  PrCheck,
  PrCheckState,
  PrCheckSummary,
  PullRequest
} from '../shared/types'
import { MERGE_STRATEGIES } from '../shared/types'

const GH_TIMEOUT = 30_000
const PR_CREATE_TIMEOUT = 120_000
const PR_MERGE_TIMEOUT = 120_000

type GhCheckRollup = {
  __typename?: string
  name?: string
  context?: string
  status?: string
  conclusion?: string | null
  state?: string
  detailsUrl?: string
  targetUrl?: string
}

type GhPr = {
  number: number
  state?: string
  mergeable?: string
  baseRefName?: string
  url?: string
  isDraft?: boolean
  statusCheckRollup?: GhCheckRollup[] | null
}

const PENDING_STATUSES = new Set(['QUEUED', 'IN_PROGRESS', 'PENDING', 'WAITING', 'REQUESTED'])
const PENDING_STATES = new Set(['PENDING', 'EXPECTED'])
const PASSED_OUTCOMES = new Set(['SUCCESS', 'PASS', 'PASSED'])
const FAILED_OUTCOMES = new Set([
  'FAILURE',
  'FAILED',
  'ERROR',
  'TIMED_OUT',
  'ACTION_REQUIRED',
  'CANCELLED',
  'CANCELED',
  'STARTUP_FAILURE'
])

/** Map a GitHub check-run / status-context row into a UI state. */
export function normalizeCheckState(raw: {
  status?: string | null
  conclusion?: string | null
  state?: string | null
}): PrCheckState {
  const status = (raw.status ?? '').toUpperCase()
  const conclusion = (raw.conclusion ?? '').toUpperCase()
  const state = (raw.state ?? '').toUpperCase()

  if (PENDING_STATUSES.has(status) || PENDING_STATES.has(state)) return 'pending'

  const outcome = conclusion || state
  if (PASSED_OUTCOMES.has(outcome)) return 'passed'
  if (FAILED_OUTCOMES.has(outcome)) return 'failed'
  if (outcome === 'SKIPPED') return 'skipped'
  if (outcome === 'NEUTRAL') return 'neutral'
  if (!outcome && (!status || status === 'COMPLETED')) return 'neutral'
  return 'pending'
}

/** Turn `gh pr view` statusCheckRollup rows into named checks. */
export function parseStatusCheckRollup(
  rollup: GhCheckRollup[] | null | undefined,
  requiredNames?: Set<string>
): PrCheck[] {
  if (!Array.isArray(rollup)) return []
  const checks: PrCheck[] = []
  const seen = new Set<string>()
  for (const raw of rollup) {
    const name = (raw.name || raw.context || '').trim()
    if (!name || seen.has(name)) continue
    seen.add(name)
    const url = (raw.detailsUrl || raw.targetUrl || '').trim()
    const check: PrCheck = {
      name,
      state: normalizeCheckState(raw),
      ...(requiredNames?.has(name) ? { required: true } : {}),
      ...(url && /^https?:\/\//i.test(url) ? { url } : {})
    }
    checks.push(check)
  }
  return checks
}

export function noPullRequestMessage(text: string): boolean {
  return /no pull requests found/i.test(text)
}

function parsePr(raw: GhPr, checks?: PrCheckSummary): PullRequest {
  const base = raw.baseRefName?.trim()
  const url = raw.url?.trim()
  return {
    number: raw.number,
    hasConflicts: raw.mergeable === 'CONFLICTING',
    ...(raw.isDraft ? { isDraft: true } : {}),
    ...(base ? { base } : {}),
    ...(url && /^https?:\/\//i.test(url) ? { url } : {}),
    ...(checks ? { checks } : {})
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

/** Names of checks that branch protection requires for this PR, when gh can list them. */
async function requiredCheckNames(cwd: string): Promise<Set<string> | undefined> {
  const res = await execCli('gh', cwd, ['pr', 'checks', '--required'], GH_TIMEOUT)
  if (res.code !== 0) return undefined
  const names = new Set<string>()
  for (const line of res.out.split('\n')) {
    const name = line.split('\t')[0]?.trim()
    if (name && name.toLowerCase() !== 'name') names.add(name)
  }
  return names
}

function checksFromView(raw: GhPr, required?: Set<string>): PrCheckSummary {
  if (!('statusCheckRollup' in raw) || raw.statusCheckRollup === undefined) {
    return { state: 'unavailable', pending: 0, passed: 0, failed: 0, skipped: 0, neutral: 0, checks: [] }
  }
  return summarizePrChecks(parseStatusCheckRollup(raw.statusCheckRollup, required), {
    requireAllWhenUnmarked: required === undefined
  })
}

/** Open PR for the current branch, if any — including draft state and Actions checks. */
export async function githubInfo(cwd: string): Promise<GitHubInfo> {
  const blocked = await ghBlockReason(cwd, 'check pull request conflicts')
  if (blocked) return { available: false, message: blocked, prs: [] }

  const view = await execCli(
    'gh',
    cwd,
    ['pr', 'view', '--json', 'number,state,mergeable,baseRefName,url,isDraft,statusCheckRollup'],
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
    // `gh pr view` falls back to merged/closed PRs for the branch; only an open one is actionable.
    if (raw.state && raw.state.toUpperCase() !== 'OPEN') return { available: true, prs: [] }
    const required = await requiredCheckNames(cwd)
    return { available: true, prs: [parsePr(raw, checksFromView(raw, required))] }
  } catch {
    return { available: false, message: 'Unexpected response from gh pr view', prs: [] }
  }
}

/**
 * Open a pull request for the current branch. `--fill` takes the title and body
 * from the branch's commits. The caller may override the target base, title,
 * and description; without them gh still falls back to the repository's default.
 */
export async function createPullRequest(
  cwd: string,
  base?: string,
  title?: string,
  body?: string
): Promise<{ ok: boolean; message: string }> {
  const blocked = await ghBlockReason(cwd, 'open pull requests')
  if (blocked) return { ok: false, message: blocked }

  const args = ['pr', 'create', '--fill']
  const baseName = base?.trim()
  if (baseName) args.push('--base', baseName)
  const prTitle = title?.trim()
  if (prTitle) args.push('--title', prTitle)
  const prBody = body?.trim()
  if (prBody) args.push('--body', prBody)

  const res = await execCli('gh', cwd, args, PR_CREATE_TIMEOUT)
  // gh prints the new PR's URL on stdout and diagnostics on stderr.
  const lines = `${res.out}\n${res.err}`.split('\n').map((l) => l.trim()).filter(Boolean)
  if (res.code !== 0) {
    return { ok: false, message: lines[0] ?? 'Could not create the pull request' }
  }
  const url = lines.find((l) => /^https?:\/\//.test(l))
  return { ok: true, message: url ? `Pull request created: ${url}` : 'Pull request created' }
}

const STRATEGY_FLAG: Record<MergeStrategy, string> = {
  merge: '--merge',
  squash: '--squash',
  rebase: '--rebase'
}

/** Merge the current branch's open PR with an explicit strategy, after local guards. */
export async function mergePullRequest(
  cwd: string,
  strategy: MergeStrategy
): Promise<{ ok: boolean; message: string }> {
  if (!(MERGE_STRATEGIES as readonly string[]).includes(strategy)) {
    return { ok: false, message: 'Choose a merge strategy.' }
  }

  const info = await githubInfo(cwd)
  if (!info.available) {
    return { ok: false, message: info.message || 'GitHub is unavailable.' }
  }
  const pr = info.prs[0]
  const reason = mergePullRequestBlockReason(pr, strategy)
  if (reason) return { ok: false, message: reason }

  const res = await execCli(
    'gh',
    cwd,
    ['pr', 'merge', String(pr!.number), STRATEGY_FLAG[strategy]],
    PR_MERGE_TIMEOUT
  )
  const lines = `${res.out}\n${res.err}`.split('\n').map((l) => l.trim()).filter(Boolean)
  if (res.code !== 0) {
    return { ok: false, message: lines[0] ?? 'Could not merge the pull request' }
  }
  return {
    ok: true,
    message: lines[0] || `Pull request #${pr!.number} merged (${strategy}).`
  }
}
