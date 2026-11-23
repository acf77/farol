/** Scores per subject, and the Markdown report a run leaves behind. */

import type { CaseResult, Category, Trace } from './types'
import { PROTOCOL_RETRIES } from './types'

export const CATEGORIES: Category[] = ['pipelines', 'git', 'todos', 'protocol', 'outcome']

export interface SubjectSummary {
  subject: string
  /** Scored runs: those where the agent's CLI ran. */
  runs: number
  /** Runs left out because the CLI never ran (see `cliError`). */
  cliErrors: number
  /** Runs where every critical check passed. */
  passed: number
  /** Runs where every check passed. */
  strict: number
  /** Check pass rate per category: passed / graded. */
  categories: Partial<Record<Category, { passed: number; total: number }>>
  attemptsPerRun: number
  /** Retries caused by unreadable control lines, across all runs. */
  protocolRetries: number
  questionsAsked: number
  secondsPerRun: number
  costUsd?: number
  outputTokens: number
}

const ratio = (passed: number, total: number): string => (total ? `${Math.round((passed / total) * 100)}%` : '–')

export function summarize(results: CaseResult[]): SubjectSummary[] {
  const bySubject = new Map<string, CaseResult[]>()
  for (const result of results) bySubject.set(result.subject, [...(bySubject.get(result.subject) ?? []), result])
  return [...bySubject.entries()].map(([subject, all]) => {
    const runs = all.filter((run) => !run.cliError)
    const categories: SubjectSummary['categories'] = {}
    for (const run of runs) {
      for (const chk of run.checks) {
        const slot = (categories[chk.category] ??= { passed: 0, total: 0 })
        slot.total += 1
        if (chk.pass) slot.passed += 1
      }
    }
    const traces = runs.map((run) => run.trace)
    const costs = traces.map((t) => t.usage.costUsd).filter((c): c is number => c !== undefined)
    return {
      subject,
      runs: runs.length,
      cliErrors: all.length - runs.length,
      passed: runs.filter((run) => run.pass).length,
      strict: runs.filter((run) => run.strict).length,
      categories,
      attemptsPerRun: avg(traces.map((t) => t.attempts.length)),
      protocolRetries: traces.reduce((n, t) => n + t.attempts.filter((a) => a.reason && PROTOCOL_RETRIES.includes(a.reason)).length, 0),
      questionsAsked: traces.reduce((n, t) => n + t.questionsAsked, 0),
      secondsPerRun: avg(traces.map((t) => t.durationMs / 1000)),
      ...(costs.length ? { costUsd: costs.reduce((a, b) => a + b, 0) } : {}),
      outputTokens: traces.reduce((n, t) => n + t.usage.outputTokens, 0)
    }
  })
}

function avg(values: number[]): number {
  return values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0
}

export interface RunMeta {
  startedAt: string
  farolVersion: string
  commit: string
  subjects: string[]
  cases: string[]
  trials: number
  /** Subjects the run gave up on, with the CLI's last word. */
  stopped?: Record<string, string>
}

const cell = (text: string): string => text.replace(/\|/g, '\\|').replace(/\n/g, ' ')

export function markdownReport(results: CaseResult[], meta: RunMeta): string {
  const summaries = summarize(results)
  const lines: string[] = [
    '# Farol tool-calling benchmark',
    '',
    `Run ${meta.startedAt} on Farol ${meta.farolVersion} (\`${meta.commit}\`), ${meta.cases.length} cases × ${meta.trials} trial${meta.trials === 1 ? '' : 's'}.`,
    '',
    'A run **passes** when every critical check passes; **strict** also counts the minor ones. Category columns are check pass rates.',
    "Runs where the agent's CLI never got going are not scored; they are counted under **CLI errors**.",
    '',
    `| Subject | Pass | Strict | ${CATEGORIES.map((c) => c[0].toUpperCase() + c.slice(1)).join(' | ')} | Attempts/run | Format retries | Questions | s/run | Cost | CLI errors |`,
    `| --- | --- | --- | ${CATEGORIES.map(() => '---').join(' | ')} | --- | --- | --- | --- | --- | --- |`
  ]
  for (const s of summaries) {
    const cats = CATEGORIES.map((c) => ratio(s.categories[c]?.passed ?? 0, s.categories[c]?.total ?? 0))
    const cost = s.costUsd === undefined ? '–' : `$${s.costUsd.toFixed(2)}`
    lines.push(
      `| ${s.subject} | ${s.passed}/${s.runs} (${ratio(s.passed, s.runs)}) | ${ratio(s.strict, s.runs)} | ${cats.join(' | ')} | ${s.attemptsPerRun.toFixed(1)} | ${s.protocolRetries} | ${s.questionsAsked} | ${Math.round(s.secondsPerRun)} | ${cost} | ${s.cliErrors || ''} |`
    )
  }
  for (const [subject, why] of Object.entries(meta.stopped ?? {})) {
    lines.push('', `**${subject} was stopped**: its CLI kept failing before it could work, so its remaining runs were skipped. Last error: ${cell(why)}`)
  }

  const subjects = summaries.map((s) => s.subject)
  lines.push('', '## Cases', '', `| Case | ${subjects.join(' | ')} |`, `| --- | ${subjects.map(() => '---').join(' | ')} |`)
  for (const caseId of meta.cases) {
    const row = subjects.map((subject) => {
      const all = results.filter((r) => r.caseId === caseId && r.subject === subject)
      const runs = all.filter((r) => !r.cliError)
      if (!all.length) return '·'
      if (!runs.length) return '⚠️ CLI'
      const passed = runs.filter((r) => r.pass).length
      const mark = passed === runs.length ? '✅' : passed ? '🟡' : '❌'
      const minor = runs.some((r) => r.pass && !r.strict) ? ' ⁺' : ''
      return `${mark} ${passed}/${runs.length}${minor}`
    })
    lines.push(`| \`${caseId}\` | ${row.join(' | ')} |`)
  }
  lines.push(
    '',
    "✅ every trial passed · 🟡 some · ❌ none · ⁺ a minor check failed in a passing trial · ⚠️ CLI the agent's CLI never ran · `·` not run on that surface"
  )

  const cliErrors = results.filter((r) => r.cliError)
  if (cliErrors.length) {
    lines.push('', '## CLI errors', '', "Not scored: the agent's CLI exited before it could do anything.", '')
    for (const r of cliErrors) lines.push(`- \`${r.caseId}\` · ${r.subject} · trial ${r.trial}: ${cell(r.cliError ?? '')}`)
  }

  const failures = results.filter((r) => !r.strict && !r.cliError)
  if (failures.length) {
    lines.push('', '## What went wrong', '')
    for (const r of failures) {
      lines.push(`### \`${r.caseId}\` · ${r.subject} · trial ${r.trial}${r.pass ? ' (passed, minor issues)' : ''}`, '')
      for (const chk of r.checks.filter((c) => !c.pass)) {
        lines.push(`- ${chk.critical ? '**' : ''}${chk.id}${chk.critical ? '**' : ''}: ${cell(chk.description)}${chk.detail ? ` (${cell(chk.detail.slice(0, 400))})` : ''}`)
      }
      lines.push(`- trace: ${traceLine(r.trace)}`, '')
    }
  }
  return `${lines.join('\n')}\n`
}

function traceLine(trace: Trace): string {
  const attempts = trace.attempts.map((a) => `${a.index + 1}${a.reason ? `:${a.reason}` : ''}`).join(' → ')
  const runs = trace.pipelineRuns.map((r) => `${r.id}${r.ok ? '✓' : '✗'}`).join(' ')
  const git = trace.gitActions.map((g) => `${g.request.action}${g.ok ? '✓' : '✗'}`).join(' ')
  return [`status ${trace.status}`, `attempts ${attempts || 'none'}`, runs && `pipelines ${runs}`, git && `git ${git}`].filter(Boolean).join(' · ')
}
