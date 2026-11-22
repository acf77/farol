/**
 * Farol's own GitHub client for pull requests: the API, as the signed-in user
 * (`githubFetch`), instead of the `gh` CLI. Answers come back in the shapes the CLI
 * printed, so `github.ts` reads either source the same way. Only github.com is spoken
 * to; any other remote is left to the CLI.
 */

import { isSafeBranchName } from '../shared/git-status'
import { GitHubSignInRequired } from '../shared/remote'
import type { MergeStrategy } from '../shared/types'
import { execCli } from './exec-cli'
import { githubFetch } from './remote'

const GIT_TIMEOUT = 10_000

/** GitHub cannot be asked from here: no github.com remote, or the network failed. The gh CLI may still be able to. */
export class GitHubUnavailable extends Error {}

/** One check run or commit status in a pull request's rollup. */
export interface CheckRollup {
  __typename?: string
  name?: string
  context?: string
  status?: string
  conclusion?: string | null
  state?: string
  detailsUrl?: string
  targetUrl?: string
}

/** A pull request as `gh pr view --json` prints it: GitHub's own GraphQL names and enums. */
export interface PullRequestView {
  number: number
  state?: string
  mergeable?: string
  baseRefName?: string
  url?: string
  isDraft?: boolean
  statusCheckRollup?: CheckRollup[] | null
}

/** The repository a branch belongs to, and where its pull requests live. */
export interface RepoRef {
  /** The repository that receives pull requests: the `upstream` remote when there is one, else `origin`. */
  owner: string
  repo: string
  /** Who owns the remote the branch is pushed to: a pull request's head. */
  headOwner: string
  /** The checked-out branch; empty on a detached HEAD. */
  branch: string
}

const GITHUB_REMOTE =
  /^(?:https:\/\/(?:[^@/\s]+@)?github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/

/** The owner and repository a github.com remote URL names, or null for any other remote. */
export function parseGitHubRemote(url: string): { owner: string; repo: string } | null {
  const [, owner, repo] = GITHUB_REMOTE.exec(url.trim()) ?? []
  // `.` and `..` match GitHub's alphabet but name no account, and would reshape an API path.
  return owner && repo && !/^\.+$/.test(owner) && !/^\.+$/.test(repo) ? { owner, repo } : null
}

/** The checked-out branch and the GitHub repository its pull requests belong to. */
export async function repoRef(cwd: string): Promise<RepoRef> {
  const [head, remotes] = await Promise.all([
    execCli('git', cwd, ['rev-parse', '--abbrev-ref', 'HEAD'], GIT_TIMEOUT),
    execCli('git', cwd, ['remote', '-v'], GIT_TIMEOUT)
  ])
  const urls = new Map<string, string>()
  for (const line of remotes.out.split('\n')) {
    const [, name, url] = /^(\S+)\s+(\S+)\s+\(fetch\)$/.exec(line.trim()) ?? []
    if (name && url) urls.set(name, url)
  }
  const origin = parseGitHubRemote(urls.get('origin') ?? [...urls.values()][0] ?? '')
  const upstream = urls.get('upstream')
  const target = upstream === undefined ? origin : parseGitHubRemote(upstream)
  if (!origin || !target) throw new GitHubUnavailable('This repository has no github.com remote.')
  const branch = head.code === 0 ? head.out.trim() : ''
  return { owner: target.owner, repo: target.repo, headOwner: origin.owner, branch: branch === 'HEAD' ? '' : branch }
}

interface ApiBody {
  message?: string
  errors?: { message?: string }[]
}

/**
 * One API call. A network failure means GitHub could not be asked, so the CLI may take
 * over; an HTTP error is GitHub's own answer and is reported as it is.
 */
async function call(path: string, init?: RequestInit): Promise<unknown> {
  let res: Response
  try {
    res = await githubFetch(path, init)
  } catch (err) {
    if (err instanceof GitHubSignInRequired) throw err
    throw new GitHubUnavailable('Could not reach GitHub.')
  }
  const body = (await res.json().catch(() => ({}))) as ApiBody
  if (res.ok) return body
  if (res.status === 404) throw new Error('GitHub could not find this repository, or this sign-in has no access to it.')
  const detail = body.errors?.find((error) => error.message)?.message
  throw new Error([body.message ?? `GitHub replied HTTP ${res.status}`, detail].filter(Boolean).join(': '))
}

const JSON_HEADERS = { 'Content-Type': 'application/json' }

async function graphql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
  const body = (await call('/graphql', {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ query, variables })
  })) as { data?: T; errors?: { message: string }[] }
  if (!body.data) throw new Error(body.errors?.[0]?.message ?? 'GitHub returned no data.')
  return body.data
}

const noRepository = (ref: RepoRef): Error =>
  new Error(`GitHub could not find ${ref.owner}/${ref.repo}, or this sign-in has no access to it.`)

const FIND_PULL_REQUEST = `query($owner:String!,$repo:String!,$head:String!){repository(owner:$owner,name:$repo){pullRequests(headRefName:$head,states:OPEN,first:10,orderBy:{field:CREATED_AT,direction:DESC}){nodes{number headRepositoryOwner{login}}}}}`

/** The open pull request whose head is this branch, on the branch owner's remote. */
export async function findPullRequestNumber(ref: RepoRef): Promise<number | undefined> {
  const data = await graphql<{
    repository: { pullRequests: { nodes: { number: number; headRepositoryOwner: { login: string } | null }[] } } | null
  }>(FIND_PULL_REQUEST, { owner: ref.owner, repo: ref.repo, head: ref.branch })
  if (!data.repository) throw noRepository(ref)
  const head = ref.headOwner.toLowerCase()
  return data.repository.pullRequests.nodes.find((pr) => pr.headRepositoryOwner?.login.toLowerCase() === head)?.number
}

const VIEW_PULL_REQUEST = `query($owner:String!,$repo:String!,$number:Int!){repository(owner:$owner,name:$repo){pullRequest(number:$number){number state mergeable baseRefName url isDraft commits(last:1){nodes{commit{statusCheckRollup{contexts(first:100){nodes{__typename ... on CheckRun{name status conclusion detailsUrl isRequired(pullRequestNumber:$number)} ... on StatusContext{context state targetUrl isRequired(pullRequestNumber:$number)}}}}}}}}}}`

type ViewNode = Omit<PullRequestView, 'statusCheckRollup'> & {
  commits: {
    nodes: { commit: { statusCheckRollup: { contexts: { nodes: (CheckRollup & { isRequired?: boolean })[] } } | null } }[]
  }
}

/** One pull request with the checks of its latest commit, and the names of the checks branch protection requires. */
export async function pullRequestView(
  ref: RepoRef,
  number: number
): Promise<{ pr: PullRequestView; required: Set<string> }> {
  const data = await graphql<{ repository: { pullRequest: ViewNode | null } | null }>(VIEW_PULL_REQUEST, {
    owner: ref.owner,
    repo: ref.repo,
    number
  })
  if (!data.repository) throw noRepository(ref)
  const node = data.repository.pullRequest
  if (!node) throw new Error(`Pull request #${number} was not found.`)
  const { commits, ...pr } = node
  const contexts = commits.nodes[0]?.commit.statusCheckRollup?.contexts.nodes ?? []
  const required = contexts.filter((check) => check.isRequired).map((check) => check.name || check.context || '')
  return { pr: { ...pr, statusCheckRollup: contexts }, required: new Set(required.filter(Boolean)) }
}

const repoPath = (ref: RepoRef): string => `/repos/${encodeURIComponent(ref.owner)}/${encodeURIComponent(ref.repo)}`

async function defaultBranch(ref: RepoRef): Promise<string> {
  const repo = (await call(repoPath(ref))) as { default_branch?: string }
  if (!repo.default_branch) throw new Error('GitHub did not say which branch is the default.')
  return repo.default_branch
}

/** The title and body `gh pr create --fill` uses: the commit when there is one, else the branch name and the commit subjects. */
async function fillFromCommits(cwd: string, base: string, branch: string): Promise<{ title: string; body: string }> {
  const log = ['log', '--reverse', '--format=%s%x1f%b%x1e']
  let res = await execCli('git', cwd, [...log, `origin/${base}..HEAD`], GIT_TIMEOUT)
  if (res.code !== 0) res = await execCli('git', cwd, [...log, `${base}..HEAD`], GIT_TIMEOUT)
  const commits = (res.code === 0 ? res.out.split('\x1e') : [])
    .map((record) => record.trim())
    .filter(Boolean)
    .map((record) => {
      const [subject = '', body = ''] = record.split('\x1f')
      return { subject: subject.trim(), body: body.trim() }
    })
  if (commits.length === 1) return { title: commits[0]!.subject, body: commits[0]!.body }
  const name = branch.replace(/[-_]+/g, ' ').trim()
  return { title: name.charAt(0).toUpperCase() + name.slice(1), body: commits.map((commit) => `- ${commit.subject}`).join('\n') }
}

/** Open a pull request from the checked-out branch; blank fields come from its commits and the repository's default branch. */
export async function createPullRequestApi(
  cwd: string,
  ref: RepoRef,
  input: { base?: string; title?: string; body?: string }
): Promise<{ number: number; url: string }> {
  const base = input.base || (await defaultBranch(ref))
  if (!isSafeBranchName(base)) throw new Error(`"${base}" is not a valid base branch name.`)
  const filled = input.title && input.body ? undefined : await fillFromCommits(cwd, base, ref.branch)
  const sameRepo = ref.headOwner.toLowerCase() === ref.owner.toLowerCase()
  const created = (await call(`${repoPath(ref)}/pulls`, {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({
      title: input.title || filled?.title,
      body: input.body || filled?.body,
      base,
      head: sameRepo ? ref.branch : `${ref.headOwner}:${ref.branch}`
    })
  })) as { number?: number; html_url?: string }
  if (typeof created.number !== 'number' || !created.html_url) throw new Error('GitHub did not return the new pull request.')
  return { number: created.number, url: created.html_url }
}

/** Merge a pull request with an explicit strategy; GitHub refuses one that is not mergeable. */
export async function mergePullRequestApi(ref: RepoRef, number: number, strategy: MergeStrategy): Promise<string> {
  const done = (await call(`${repoPath(ref)}/pulls/${number}/merge`, {
    method: 'PUT',
    headers: JSON_HEADERS,
    body: JSON.stringify({ merge_method: strategy })
  })) as { message?: string }
  return done.message ?? `Pull request #${number} merged (${strategy}).`
}
