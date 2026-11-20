import { app } from 'electron'
import path from 'path'
import { mergePullRequestBlockReason, summarizePrChecks } from '../shared/git-status'
import { GitHubSignInRequired } from '../shared/remote'
import type {
  GitHubInfo,
  MergeStrategy,
  PrCheck,
  PrCheckState,
  PrCheckSummary,
  PullRequest
} from '../shared/types'
import { MERGE_STRATEGIES } from '../shared/types'
import { execCli } from './exec-cli'
import { CREDENTIAL_NONCE_ENV, CREDENTIAL_SOCKET_ENV, grantCredential } from './git-credential-broker'
import { githubToken } from './remote'
import {
  createPullRequestApi,
  findPullRequestNumber,
  GitHubReply,
  GitHubUnavailable,
  mergePullRequestApi,
  pullRequestView,
  repoRef,
  type CheckRollup,
  type PullRequestView,
  type RepoRef
} from './github-api'

/**
 * Pull requests and their checks. The GitHub API, as the signed-in user, answers first
 * (`github-api.ts`). The `gh` CLI is the fallback for when the API cannot be asked: no
 * sign-in, a remote that is not github.com, or no network. An HTTP error from GitHub is its
 * own answer and is reported as it is.
 */

const GH_TIMEOUT = 30_000
const PR_CREATE_TIMEOUT = 120_000
const PR_MERGE_TIMEOUT = 120_000
const PR_FIELDS = 'number,state,mergeable,baseRefName,url,isDraft,statusCheckRollup'

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

/** Turn a pull request's statusCheckRollup rows into named checks. */
export function parseStatusCheckRollup(
  rollup: CheckRollup[] | null | undefined,
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

function parsePr(raw: PullRequestView, checks?: PrCheckSummary): PullRequest {
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

function checksFromView(raw: PullRequestView, required?: Set<string>): PrCheckSummary {
  if (!('statusCheckRollup' in raw) || raw.statusCheckRollup === undefined) {
    return { state: 'unavailable', pending: 0, passed: 0, failed: 0, skipped: 0, neutral: 0, checks: [] }
  }
  return summarizePrChecks(parseStatusCheckRollup(raw.statusCheckRollup, required), {
    requireAllWhenUnmarked: required === undefined
  })
}

/** Whether the gh CLI should take over from an API call that failed with `err`; any other error is GitHub's own answer. */
const ghMayHelp = (err: unknown): boolean => err instanceof GitHubUnavailable || err instanceof GitHubSignInRequired

const UNEXPECTED_MESSAGE = 'Could not complete the GitHub request.'

/** What a person may read about `err`: a message Farol or GitHub worded; any other failure is logged and not shown. */
function publicMessage(err: unknown): string {
  if (err instanceof GitHubUnavailable || err instanceof GitHubSignInRequired || err instanceof GitHubReply) return err.message
  console.error('Unexpected GitHub failure:', err)
  return UNEXPECTED_MESSAGE
}

/** What the Git panel is told when neither the API nor the CLI could answer. */
function unavailable(cause: unknown): GitHubInfo {
  return {
    available: false,
    message: publicMessage(cause),
    prs: [],
    ...(cause instanceof GitHubSignInRequired ? { signInRequired: true as const } : {})
  }
}

function shellQuote(p: string): string {
  return `'${p.replace(/'/g, `'\\''`)}'`
}

function gitCredentialHelper(): string {
  const script = path.join(app.getAppPath(), 'out', 'main', 'git-credential.js')
  return `!${shellQuote(process.execPath)} ${shellQuote(script)}`
}

/**
 * Extra environment for one git transport. Registers a Farol credential helper
 * for github.com so git asks for the password only when it talks to the remote,
 * after client-side hooks run, and the token is not in GIT_CONFIG_VALUE_*. An empty helper first
 * clears the chain, so no other configured helper is asked for a login or is handed the token to
 * store. The caller ends the command's one-use grant with `releaseCredential`.
 */
export async function githubGitEnv(): Promise<Record<string, string> | undefined> {
  if (!(await githubToken())) return undefined
  const { socket, nonce } = await grantCredential(githubToken)
  const next = Number(process.env.GIT_CONFIG_COUNT) || 0
  return {
    [CREDENTIAL_SOCKET_ENV]: socket,
    [CREDENTIAL_NONCE_ENV]: nonce,
    GIT_TERMINAL_PROMPT: '0',
    ELECTRON_RUN_AS_NODE: '1',
    GIT_CONFIG_COUNT: String(next + 2),
    [`GIT_CONFIG_KEY_${next}`]: 'credential.https://github.com.helper',
    [`GIT_CONFIG_VALUE_${next}`]: '',
    [`GIT_CONFIG_KEY_${next + 1}`]: 'credential.https://github.com.helper',
    [`GIT_CONFIG_VALUE_${next + 1}`]: gitCredentialHelper()
  }
}

const GH_READY_TTL_MS = 5 * 60_000
let ghReadyUntil = 0

/** Whether the gh CLI is installed and logged in. A healthy answer is remembered, so each poll skips two process spawns. */
async function ghReady(cwd: string): Promise<boolean> {
  if (Date.now() < ghReadyUntil) return true
  const [version, auth] = await Promise.all([
    execCli('gh', cwd, ['--version'], GH_TIMEOUT),
    execCli('gh', cwd, ['auth', 'status'], GH_TIMEOUT)
  ])
  if (version.code !== 0 || auth.code !== 0) return false
  ghReadyUntil = Date.now() + GH_READY_TTL_MS
  return true
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

/** An open pull request as the Git panel shows it; a finished one is no pull request. */
function openPullRequestInfo(pr: PullRequestView, required?: Set<string>): GitHubInfo {
  if (pr.state && pr.state.toUpperCase() !== 'OPEN') return { available: true, prs: [] }
  return { available: true, prs: [parsePr(pr, checksFromView(pr, required))] }
}

/** The pull request's open state and checks from the API; branch protection decides which checks are required. */
async function apiPullRequestInfo(ref: RepoRef, number: number): Promise<GitHubInfo> {
  const { pr, required } = await pullRequestView(ref, number)
  return openPullRequestInfo(pr, required.size ? required : undefined)
}

async function apiInfo(cwd: string): Promise<GitHubInfo> {
  const ref = await repoRef(cwd)
  const number = ref.branch ? await findPullRequestNumber(ref) : undefined
  return number === undefined ? { available: true, prs: [] } : apiPullRequestInfo(ref, number)
}

/** Load one open PR by URL right after create — skips a full branch scan. */
async function ghInfoFromCreatedUrl(cwd: string, url: string): Promise<GitHubInfo | undefined> {
  const view = await execCli('gh', cwd, ['pr', 'view', url, '--json', PR_FIELDS], GH_TIMEOUT)
  if (view.code !== 0) return undefined
  try {
    const raw = JSON.parse(view.out) as PullRequestView
    return openPullRequestInfo(raw, await requiredCheckNames(cwd))
  } catch {
    return undefined
  }
}

async function ghInfo(cwd: string, cause: unknown): Promise<GitHubInfo> {
  if (!(await ghReady(cwd))) return unavailable(cause)
  const view = await execCli('gh', cwd, ['pr', 'view', '--json', PR_FIELDS], GH_TIMEOUT)
  if (view.code !== 0) {
    const text = (view.err || view.out).trim()
    if (noPullRequestMessage(text)) return { available: true, prs: [] }
    const message = text.split('\n')[0] || 'could not read pull request'
    return { available: false, message, prs: [] }
  }

  try {
    // `gh pr view` falls back to merged/closed PRs for the branch; only an open one is actionable.
    return openPullRequestInfo(JSON.parse(view.out) as PullRequestView, await requiredCheckNames(cwd))
  } catch {
    return { available: false, message: 'Unexpected response from gh pr view', prs: [] }
  }
}

/** Open PR for the current branch, if any — including draft state and Actions checks. */
export async function githubInfo(cwd: string): Promise<GitHubInfo> {
  try {
    return await apiInfo(cwd)
  } catch (err) {
    return ghMayHelp(err) ? ghInfo(cwd, err) : unavailable(err)
  }
}

type Created = { ok: boolean; message: string; github?: GitHubInfo }

async function apiCreate(cwd: string, base?: string, title?: string, body?: string): Promise<Created> {
  const ref = await repoRef(cwd)
  if (!ref.branch) return { ok: false, message: 'Check out a branch to open a pull request.' }
  const created = await createPullRequestApi(cwd, ref, { base: base?.trim(), title: title?.trim(), body: body?.trim() })
  const github = await apiPullRequestInfo(ref, created.number).catch(() => undefined)
  return { ok: true, message: `Pull request created: ${created.url}`, ...(github?.prs.length ? { github } : {}) }
}

/**
 * `--fill` takes the title and body from the branch's commits. The caller may override the
 * target base, title, and description; without them gh still falls back to the repository's default.
 */
async function ghCreate(cwd: string, cause: unknown, base?: string, title?: string, body?: string): Promise<Created> {
  if (!(await ghReady(cwd))) return { ok: false, message: publicMessage(cause) }

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
  const message = url ? `Pull request created: ${url}` : 'Pull request created'
  const github = url
    ? await ghInfoFromCreatedUrl(cwd, url).catch(() => undefined)
    : await githubInfo(cwd).catch(() => undefined)
  return { ok: true, message, ...(github?.prs.length ? { github } : {}) }
}

/** Open a pull request for the current branch. Blank base, title and description come from the repository and the branch's commits. */
export async function createPullRequest(
  cwd: string,
  base?: string,
  title?: string,
  body?: string
): Promise<Created> {
  try {
    return await apiCreate(cwd, base, title, body)
  } catch (err) {
    return ghMayHelp(err) ? ghCreate(cwd, err, base, title, body) : { ok: false, message: publicMessage(err) }
  }
}

const STRATEGY_FLAG: Record<MergeStrategy, string> = {
  merge: '--merge',
  squash: '--squash',
  rebase: '--rebase'
}

async function ghMerge(
  cwd: string,
  cause: unknown,
  number: number,
  strategy: MergeStrategy
): Promise<{ ok: boolean; message: string }> {
  if (!(await ghReady(cwd))) return { ok: false, message: publicMessage(cause) }
  const res = await execCli('gh', cwd, ['pr', 'merge', String(number), STRATEGY_FLAG[strategy]], PR_MERGE_TIMEOUT)
  const lines = `${res.out}\n${res.err}`.split('\n').map((l) => l.trim()).filter(Boolean)
  if (res.code !== 0) {
    return { ok: false, message: lines[0] ?? 'Could not merge the pull request' }
  }
  return { ok: true, message: lines[0] || `Pull request #${number} merged (${strategy}).` }
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

  try {
    return { ok: true, message: await mergePullRequestApi(await repoRef(cwd), pr!.number, strategy) }
  } catch (err) {
    return ghMayHelp(err) ? ghMerge(cwd, err, pr!.number, strategy) : { ok: false, message: publicMessage(err) }
  }
}
