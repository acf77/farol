/**
 * Checks graded on a run's trace, and the readers they share. A check is a
 * small pure function, so a case lists what it expects in a few lines and the
 * tests can prove each check against hand-made traces.
 */

import { isShellToolName, matchedCatalogShells } from '../shared/catalog-shell'
import {
  BLOCK_MARKER,
  FINISHED_PLAN,
  GIT_MARKER,
  PIPELINES_MARKER,
  PLAN_MARKER,
  QUESTIONS_MARKER,
  isControlLine,
  lastControlLine,
  lastNonEmptyLine
} from '../shared/control-line'
import type { Todo, TodoPriority, TodoStatus } from '../shared/todos'
import {
  PROTOCOL_RETRIES,
  type AttemptTrace,
  type BenchCase,
  type CaseResult,
  type Category,
  type Check,
  type CheckResult,
  type RetryReason,
  type Trace
} from './types'

// ---------------------------------------------------------------------------
// Reading a trace

/** Why Farol started an attempt, from the opening of the prompt it sent. */
export function retryReason(prompt: string): RetryReason {
  if (prompt.includes('Farol could not validate because your pipeline selection was invalid')) return 'invalid-pipeline-selection'
  if (prompt.includes('Farol could not validate because you bypassed pipelines')) return 'self-ran-pipeline'
  if (prompt.includes('Farol could not validate because you skipped mandatory pipelines')) return 'skipped-mandatory'
  if (prompt.includes('Farol could not show your questions because')) return 'invalid-questions'
  if (prompt.includes(`Farol could not read a ${GIT_MARKER} line`)) return 'invalid-git-line'
  if (prompt.includes(`then send the ${GIT_MARKER} line again`)) return 'git-hook-blocked'
  if (/Farol validation attempt \d+ failed/.test(prompt)) return 'validation-failed'
  if (prompt.includes(`End this Plan response with ${FINISHED_PLAN}`)) return 'plan-marker'
  if (prompt.includes('User request:') || prompt.includes('Additional user guidance')) return 'user'
  return 'other'
}

/** The bare ids an attempt selected with `FAROL_PIPELINES`; `null` when it has no such line or it is not a string array. */
export function attemptSelection(attempt: Pick<AttemptTrace, 'text'>, bareIds: Map<string, string>): string[] | null {
  const raw = lastControlLine(attempt.text, PIPELINES_MARKER)
  if (raw === undefined) return null
  try {
    const ids = JSON.parse(raw) as unknown
    if (!Array.isArray(ids) || ids.some((id) => typeof id !== 'string')) return null
    return (ids as string[]).map((id) => bareIds.get(id) ?? id)
  } catch {
    return null
  }
}

/** Every bare id a trace's attempts selected or ran. */
function everSelected(trace: Trace): Set<string> {
  const ids = new Set(trace.pipelineRuns.map((run) => run.id))
  for (const attempt of trace.attempts) for (const id of attempt.selection ?? []) ids.add(id)
  return ids
}

export function shellCommands(trace: Trace): string[] {
  return trace.attempts.flatMap((attempt) =>
    attempt.tools.filter((tool) => isShellToolName(tool.name) && tool.detail).map((tool) => tool.detail as string)
  )
}

/** Catalog commands the agent ran itself instead of asking Farol to. */
export function selfRanCatalog(trace: Trace): string[] {
  return matchedCatalogShells(shellCommands(trace), [...new Set(trace.catalog.flatMap((p) => p.cmds))])
}

const SELF_GIT = /\bgit\s+(?:-C\s+\S+\s+)?(?:commit|push)\b|\bgh\s+pr\s+create\b/

/** The marker an attempt ended on, when its last line is one Farol accepts as final. */
export function finalMarker(text: string): string | undefined {
  const last = lastNonEmptyLine(text)
  if (!last || last.fenced || !isControlLine(last.line)) return undefined
  const line = last.line.trimStart()
  return [PIPELINES_MARKER, QUESTIONS_MARKER, PLAN_MARKER, BLOCK_MARKER].find((marker) => line.startsWith(marker))
}

/** The last non-empty line of what an agent said: where a CLI's own error ends up. */
export function lastLine(text: string): string {
  return text.trim().split('\n').at(-1)?.trim().slice(0, 300) ?? ''
}

/**
 * Why the agent's CLI never got going (every attempt exited non-zero without using a tool), or
 * undefined. Such a run says nothing about the model, so it is reported apart and not scored.
 */
export function cliFailure(trace: Trace): string | undefined {
  if (trace.status === 'completed' || !trace.attempts.length) return undefined
  if (trace.attempts.some((a) => a.exitCode === 0 || a.tools.length)) return undefined
  return lastLine(trace.attempts.at(-1)?.text ?? '') || trace.statusMessage
}

const pass = (detail?: string): CheckResult => ({ pass: true, ...(detail ? { detail } : {}) })
const fail = (detail: string): CheckResult => ({ pass: false, detail })
const list = (items: string[]): string => items.join(', ') || 'none'

function check(
  id: string,
  category: Category,
  critical: boolean,
  description: string,
  grade: (trace: Trace) => CheckResult
): Check {
  return { id, category, critical, description, grade }
}

// ---------------------------------------------------------------------------
// Pipelines

/** Each pipeline ran on the agent's final code: after its last change, with nothing changed since. */
export function validates(ids: string[], critical = true): Check {
  return check(
    `pipelines.validates:${ids.join('+')}`,
    'pipelines',
    critical,
    `${list(ids)} ran on the agent's final code`,
    (trace) => {
      const missing = ids.filter((id) => !trace.pipelineRuns.some((run) => run.id === id && run.tree === trace.finalTree))
      if (!missing.length) return pass()
      const stale = missing.filter((id) => trace.pipelineRuns.some((run) => run.id === id))
      return fail(
        `not run on the final code: ${list(missing)}${stale.length ? ` (${list(stale)} ran, but before a later change)` : ''}; selected: ${list([...everSelected(trace)])}`
      )
    }
  )
}

export function neverSelects(ids: string[]): Check {
  return check(`pipelines.never:${ids.join('+')}`, 'pipelines', true, `never selects ${list(ids)}`, (trace) => {
    const hit = ids.filter((id) => everSelected(trace).has(id))
    return hit.length ? fail(`selected ${list(hit)}`) : pass()
  })
}

/** Nothing to validate: no pipeline ran, and every Build answer selected `[]`. */
export function noValidation(): Check {
  return check('pipelines.none', 'pipelines', true, 'selects no pipeline when nothing changed', (trace) => {
    if (trace.pipelineRuns.length) return fail(`ran ${list(trace.pipelineRuns.map((run) => run.id))}`)
    const chose = [...everSelected(trace)]
    return chose.length ? fail(`selected ${list(chose)}`) : pass()
  })
}

/** Farol's rule: never run a catalog command yourself; select its pipeline. */
export function noSelfRun(critical = false): Check {
  return check('pipelines.no-self-run', 'pipelines', critical, 'never runs a pipeline command itself', (trace) => {
    const ran = selfRanCatalog(trace)
    return ran.length ? fail(`ran ${list(ran.map((cmd) => `\`${cmd}\``))}`) : pass()
  })
}

/** After a failed validation, the repair attempt selects the pipelines that failed again. */
export function reselectsFailed(): Check {
  return check('pipelines.reselects-failed', 'pipelines', false, 're-selects failed pipelines on a repair', (trace) => {
    const misses: string[] = []
    for (const attempt of trace.attempts) {
      if (attempt.reason !== 'validation-failed') continue
      const failed = trace.pipelineRuns.filter((run) => run.afterAttempt === attempt.index && !run.ok).map((run) => run.id)
      const picked = attempt.selection ?? []
      const dropped = failed.filter((id) => !picked.includes(id))
      if (dropped.length) misses.push(`attempt ${attempt.index + 1} dropped ${list(dropped)}`)
    }
    return misses.length ? fail(misses.join('; ')) : pass()
  })
}

// ---------------------------------------------------------------------------
// Git

type GitKind = 'status' | 'commit' | 'push' | 'create_pr'

/** The Git actions that succeeded, in order, are exactly these. */
export function gitActions(expected: GitKind[]): Check {
  const want = expected.filter((kind) => kind !== 'status')
  return check(
    `git.actions:${want.join('+') || 'none'}`,
    'git',
    true,
    want.length ? `asks Farol to ${want.join(', then ')}` : 'asks for no commit, push or pull request',
    (trace) => {
      const done = trace.gitActions.filter((a) => a.ok && a.request.action !== 'status').map((a) => a.request.action)
      const asked = trace.gitActions.filter((a) => a.request.action !== 'status').map((a) => `${a.request.action}${a.ok ? '' : ' (failed)'}`)
      return done.join(',') === want.join(',') ? pass() : fail(`got ${list(asked)}`)
    }
  )
}

/** Farol's rule when Git actions are on: never commit, push or open a PR from the shell. */
export function noSelfGit(): Check {
  return check('git.no-self-git', 'git', true, 'never commits, pushes or opens a PR from the shell', (trace) => {
    const hits = shellCommands(trace).filter((cmd) => SELF_GIT.test(cmd))
    return hits.length ? fail(`ran ${list(hits.map((cmd) => `\`${cmd.slice(0, 80)}\``))}`) : pass()
  })
}

export function commitMessage(): Check {
  return check('git.commit-message', 'git', false, 'writes a real commit message (subject of 10-72 characters)', (trace) => {
    const commits = trace.gitActions.filter((a) => a.request.action === 'commit')
    const bad = commits
      .map((a) => (a.request.action === 'commit' ? a.request.message.split('\n')[0].trim() : ''))
      .filter((subject) => subject.length < 10 || subject.length > 72 || /<[^>]+>/.test(subject))
    if (!commits.length) return fail('no commit requested')
    return bad.length ? fail(`subject: ${bad.map((s) => JSON.stringify(s)).join(', ')}`) : pass()
  })
}

export function prBase(base: string): Check {
  return check('git.pr-base', 'git', false, `opens the pull request against ${base}`, (trace) => {
    const pr = trace.gitActions.find((a) => a.request.action === 'create_pr')
    if (!pr || pr.request.action !== 'create_pr') return fail('no pull request requested')
    return pr.request.base === undefined || pr.request.base === base ? pass() : fail(`base ${pr.request.base}`)
  })
}

/** Every Git action went through the first time. */
export function gitFirstTry(): Check {
  return check('git.first-try', 'git', false, 'no Git action is blocked or fails', (trace) => {
    const failed = trace.gitActions.filter((a) => !a.ok)
    return failed.length ? fail(failed.map((a) => `${a.request.action}: ${a.message.slice(0, 120)}`).join('; ')) : pass()
  })
}

// ---------------------------------------------------------------------------
// Todos

function todoLabel(todo: Todo): string {
  return `"${todo.content}" ${todo.status}/${todo.priority}`
}

export function todoHas(match: RegExp, want: { status?: TodoStatus[]; priority?: TodoPriority } = {}): Check {
  const extras = [want.status ? want.status.join('|') : '', want.priority ?? ''].filter(Boolean).join(', ')
  return check(`todos.has:${match.source}`, 'todos', true, `todo list has ${match}${extras ? ` (${extras})` : ''}`, (trace) => {
    const found = trace.todosAfter.filter((todo) => match.test(todo.content))
    if (!found.length) return fail(`not in the list: ${list(trace.todosAfter.map(todoLabel))}`)
    const ok = found.find(
      (todo) => (!want.status || want.status.includes(todo.status)) && (!want.priority || todo.priority === want.priority)
    )
    return ok ? pass() : fail(`found ${list(found.map(todoLabel))}`)
  })
}

/** An item from the starting list is still there, as it was. */
export function todoUnchanged(content: string): Check {
  return check(`todos.unchanged:${content}`, 'todos', true, `leaves "${content}" as it was`, (trace) => {
    const before = trace.todosBefore.find((todo) => todo.content === content)
    const after = trace.todosAfter.find((todo) => todo.content === content)
    if (!before) return fail('not in the starting list (case error)')
    if (!after) return fail(`dropped; list is ${list(trace.todosAfter.map(todoLabel))}`)
    return after.status === before.status && after.priority === before.priority ? pass() : fail(`now ${todoLabel(after)}`)
  })
}

/** An item is off the list, or marked cancelled. */
export function todoGone(match: RegExp): Check {
  return check(`todos.gone:${match.source}`, 'todos', true, `removes or cancels ${match}`, (trace) => {
    const left = trace.todosAfter.filter((todo) => match.test(todo.content) && todo.status !== 'cancelled')
    return left.length ? fail(`still ${list(left.map(todoLabel))}`) : pass()
  })
}

/** Some list the agent saved had at least `min` items: it planned the work in the list. */
export function todoTracked(min: number): Check {
  return check(`todos.tracked:${min}`, 'todos', true, `tracks the work as at least ${min} todos`, (trace) => {
    const most = Math.max(0, ...trace.todoSaves.map((saved) => saved.length))
    return most >= min ? pass(`${trace.todoSaves.length} updates`) : fail(`largest list had ${most} items`)
  })
}

/** At the end nothing is left open: every item done or cancelled (or the list cleared after use). */
export function todosAllDone(): Check {
  return check('todos.all-done', 'todos', true, 'closes every todo it worked on', (trace) => {
    const open = trace.todosAfter.filter((todo) => todo.status === 'pending' || todo.status === 'in_progress')
    if (open.length) return fail(`still open: ${list(open.map(todoLabel))}`)
    if (!trace.todosAfter.length && !trace.todoSaves.some((saved) => saved.length)) return fail('never kept a list')
    return pass()
  })
}

/** Farol's rule: at most one todo in progress at a time. */
export function oneInProgress(): Check {
  return check('todos.one-in-progress', 'todos', false, 'never has more than one todo in progress', (trace) => {
    const over = trace.todoSaves.filter((saved) => saved.filter((todo) => todo.status === 'in_progress').length > 1)
    return over.length ? fail(`${over.length} update(s) had several in progress`) : pass()
  })
}

/** Todo updates were read: an update whose line Farol rejected never reaches the list. */
export function todosSaved(): Check {
  return check('todos.saved', 'todos', true, 'sends a todo update Farol accepts', (trace) =>
    trace.todoSaves.length ? pass(`${trace.todoSaves.length} updates`) : fail('no FAROL_TODOS update was accepted')
  )
}

// ---------------------------------------------------------------------------
// Plan

export function planFinished(): Check {
  return check('protocol.plan-finished', 'protocol', true, `ends the plan with ${FINISHED_PLAN}`, (trace) => {
    const last = trace.attempts.at(-1)
    if (!last) return fail('no attempt')
    return lastNonEmptyLine(last.text)?.line.trim() === FINISHED_PLAN ? pass() : fail(`last line: ${JSON.stringify(lastNonEmptyLine(last.text)?.line.slice(0, 80) ?? '')}`)
  })
}

// ---------------------------------------------------------------------------
// Checks every case gets

function completed(): Check {
  return check('outcome.completed', 'outcome', true, 'the chat finishes on its own', (trace) =>
    trace.status === 'completed' ? pass() : fail(`${trace.status}: ${trace.statusMessage}`)
  )
}

function acceptance(): Check {
  return check('outcome.acceptance', 'outcome', true, 'the task is actually done (acceptance commands pass)', (trace) => {
    const failed = trace.acceptance.filter((a) => !a.ok)
    return failed.length ? fail(failed.map((a) => `${a.name}: ${a.output.split('\n').slice(-3).join(' ').slice(0, 200)}`).join('; ')) : pass()
  })
}

function filesExpectation(changes: boolean): Check {
  return changes
    ? check('outcome.changes-files', 'outcome', true, 'changes files', (trace) =>
        trace.agentChangedFiles.length ? pass(list(trace.agentChangedFiles)) : fail('changed nothing')
      )
    : check('outcome.no-changes', 'outcome', true, 'changes no files', (trace) =>
        trace.agentChangedFiles.length ? fail(`changed ${list(trace.agentChangedFiles)}`) : pass()
      )
}

function noFormatRetries(): Check {
  return check('protocol.no-format-retries', 'protocol', false, 'Farol never has to ask again for a readable control line', (trace) => {
    const bad = trace.attempts.filter((a) => a.reason && PROTOCOL_RETRIES.includes(a.reason)).map((a) => `${a.reason}`)
    return bad.length ? fail(list(bad)) : pass()
  })
}

function endsWithMarker(): Check {
  return check('protocol.final-line', 'protocol', false, 'every answer ends with exactly one final control line', (trace) => {
    const bad = trace.attempts.filter((a) => !finalMarker(a.text)).map((a) => `attempt ${a.index + 1}: ${JSON.stringify(lastNonEmptyLine(a.text)?.line.slice(0, 60) ?? '')}`)
    return bad.length ? fail(bad.join('; ')) : pass()
  })
}

function noFarolMcp(): Check {
  return check('protocol.no-farol-mcp', 'protocol', true, "never calls Farol's MCP pipeline or Git tools in Chat", (trace) => {
    const hits = trace.attempts.flatMap((a) => a.tools.map((tool) => tool.name)).filter((name) => /mcp__farol__/.test(name))
    return hits.length ? fail(list([...new Set(hits)])) : pass()
  })
}

/** The checks a case is graded on for a surface: its own, plus the ones every case gets. */
export function checksFor(c: BenchCase, surface: Trace['surface']): Check[] {
  const common = [completed(), filesExpectation(c.changesFiles), ...(c.acceptance?.length ? [acceptance()] : [])]
  const chat = surface === 'chat' ? [noFormatRetries(), endsWithMarker(), noFarolMcp()] : []
  const own = surface === 'chat' ? c.checks : (c.mcpChecks ?? [])
  return [...own, ...chat, ...common]
}

export function grade(c: BenchCase, trace: Trace): CaseResult {
  const checks = checksFor(c, trace.surface).map((chk) => {
    let result: CheckResult
    try {
      result = chk.grade(trace)
    } catch (error) {
      result = fail(`check threw: ${error instanceof Error ? error.message : String(error)}`)
    }
    return { id: chk.id, category: chk.category, critical: chk.critical, description: chk.description, ...result }
  })
  const cliError = cliFailure(trace)
  return {
    caseId: c.id,
    subject: trace.subject,
    trial: trace.trial,
    ...(cliError ? { cliError } : {}),
    pass: checks.every((chk) => chk.pass || !chk.critical),
    strict: checks.every((chk) => chk.pass),
    checks,
    trace
  }
}
