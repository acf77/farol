/**
 * farol-bench: how well an agent uses Farol's tools.
 *
 *   bun run bench -- --subjects chat/claude:claude-opus-5-5,chat/claude:claude-sonnet-5-5 --trials 3
 *
 * Subjects are `[surface/]provider[:model][@effort]`: surface `chat` (Farol's
 * managed Chat, the default) or `mcp` (the CLI alone with Farol's MCP server);
 * provider is any Farol agent CLI (claude, codex, cursor, opencode, omp, …).
 * Every run starts from a fresh copy of the fixture; results go to `--out`.
 */

import { execFileSync } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { fileURLToPath } from 'url'
import { CASES, selectCases } from './cases'
import { grade } from './grade'
import { runChat, scriptedAgent } from './harness/chat'
import { runMcp } from './harness/mcp'
import { markdownReport, summarize, type RunMeta } from './report'
import { parseSubject } from './subject'
import type { BenchCase, CaseResult, Subject } from './types'

const DEFAULT_SUBJECTS = ['chat/claude:claude-opus-5-5', 'chat/claude:claude-sonnet-5-5']

interface Args {
  subjects: Subject[]
  cases: BenchCase[]
  trials: number
  concurrency: number
  timeoutMs: number
  out: string
  keep: boolean
  /** Play each case's reference instead of a model: checks the bench itself, for free. */
  reference: boolean
}

function usage(): never {
  console.log(`Usage: bun run bench -- [options]

  --subjects a,b     [chat|mcp/]provider[:model][@effort], comma-separated
                     (default ${DEFAULT_SUBJECTS.join(',')})
  --cases p,q        case ids or globs, e.g. git/*,todos/add (default all)
  --trials n         runs of each case per subject (default 1)
  --concurrency n    runs at once (default 2)
  --timeout s        seconds before a run is stopped (default 900)
  --out dir          where results go (default bench/results/<time>)
  --keep             leave each run's checkout on disk
  --reference        run each case's reference solution instead of a model
                     (checks the bench and this machine; spends no tokens)
  --list             list the cases and exit
  --report file      rebuild report.md from a results.json and exit`)
  process.exit(0)
}

function parseArgs(argv: string[]): Args | 'listed' {
  const value = (flag: string): string | undefined => {
    const i = argv.indexOf(flag)
    return i >= 0 ? argv[i + 1] : undefined
  }
  if (argv.includes('--help') || argv.includes('-h')) usage()
  if (argv.includes('--list')) {
    for (const c of CASES) console.log(`${c.id.padEnd(24)} ${c.mcpChecks ? 'chat+mcp' : 'chat    '}  ${c.title}`)
    return 'listed'
  }
  const report = value('--report')
  if (report) {
    const saved = JSON.parse(fs.readFileSync(report, 'utf8')) as { meta: RunMeta; results: CaseResult[] }
    const file = path.join(path.dirname(report), 'report.md')
    fs.writeFileSync(file, markdownReport(saved.results, saved.meta))
    console.log(`Wrote ${file}`)
    return 'listed'
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const reference = argv.includes('--reference')
  return {
    subjects: reference ? [parseSubject('chat/claude:reference')] : (value('--subjects')?.split(',') ?? DEFAULT_SUBJECTS).filter(Boolean).map(parseSubject),
    cases: selectCases(value('--cases')?.split(',').filter(Boolean) ?? []),
    trials: Math.max(1, Number(value('--trials') ?? 1)),
    concurrency: Math.max(1, Number(value('--concurrency') ?? 2)),
    timeoutMs: Math.max(30, Number(value('--timeout') ?? 900)) * 1000,
    out: path.resolve(value('--out') ?? path.join('bench', 'results', stamp)),
    keep: argv.includes('--keep'),
    reference
  }
}

function sh(cmd: string, args: string[]): string {
  try {
    return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  } catch {
    return 'unknown'
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  if (args === 'listed') return
  // Jev has no key in a bench run, so each turn would log that it skipped.
  const info = console.info.bind(console)
  console.info = (...line: unknown[]) => {
    if (line[0] !== '[farol] Jev') info(...line)
  }
  process.on('unhandledRejection', (reason) => console.error(`  (ignored) ${reason instanceof Error ? reason.message : String(reason)}`))

  fs.mkdirSync(args.out, { recursive: true })
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'farol-bench-'))
  const pkg = JSON.parse(fs.readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8')) as { version: string }
  const meta: RunMeta = {
    startedAt: new Date().toISOString(),
    farolVersion: pkg.version,
    commit: sh('git', ['rev-parse', '--short', 'HEAD']),
    subjects: args.subjects.map((s) => s.label),
    cases: args.cases.map((c) => c.id),
    trials: args.trials
  }

  const jobs = args.subjects.flatMap((subject) =>
    args.cases
      .filter((c) => subject.surface === 'chat' || c.mcpChecks)
      .flatMap((c) => Array.from({ length: args.trials }, (_, i) => ({ subject, c, trial: i + 1 })))
  )
  console.log(`farol-bench: ${jobs.length} runs (${args.subjects.length} subjects, ${args.cases.length} cases, ${args.trials} trials) → ${args.out}`)

  const results: CaseResult[] = []
  const stream = fs.createWriteStream(path.join(args.out, 'results.jsonl'))
  let next = 0
  let done = 0
  const worker = async (): Promise<void> => {
    while (next < jobs.length) {
      const { subject, c, trial } = jobs[next++]
      const opts = {
        trial,
        root,
        timeoutMs: args.timeoutMs,
        keep: args.keep,
        log: (line: string) => console.log(line),
        ...(args.reference ? { executor: scriptedAgent(c.reference) } : {})
      }
      console.log(`▶ ${subject.label}  ${c.id}  #${trial}`)
      const trace = subject.surface === 'mcp' ? await runMcp(c, subject, opts) : await runChat(c, subject, opts)
      const result = grade(c, trace)
      results.push(result)
      stream.write(`${JSON.stringify(result)}\n`)
      done += 1
      const failed = result.checks.filter((chk) => !chk.pass).map((chk) => chk.id)
      console.log(`${result.pass ? '✔' : '✘'} [${done}/${jobs.length}] ${subject.label}  ${c.id}  #${trial}  ${Math.round(trace.durationMs / 1000)}s${failed.length ? `  failed: ${failed.join(', ')}` : ''}`)
    }
  }
  await Promise.all(Array.from({ length: Math.min(args.concurrency, jobs.length) }, worker))
  stream.end()

  const order = (r: CaseResult): string => `${args.subjects.findIndex((s) => s.label === r.subject)}:${meta.cases.indexOf(r.caseId)}:${r.trial}`
  results.sort((a, b) => order(a).localeCompare(order(b), undefined, { numeric: true }))
  fs.writeFileSync(path.join(args.out, 'results.json'), JSON.stringify({ meta, summaries: summarize(results), results }, null, 2))
  fs.writeFileSync(path.join(args.out, 'report.md'), markdownReport(results, meta))
  if (!args.keep) fs.rmSync(root, { recursive: true, force: true })

  console.log('')
  for (const s of summarize(results)) {
    console.log(`${s.subject.padEnd(40)} ${s.passed}/${s.runs} passed  ${s.costUsd === undefined ? '' : `$${s.costUsd.toFixed(2)}`}`)
  }
  console.log(`\nReport: ${path.join(args.out, 'report.md')}`)
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack ?? error.message : error)
    process.exit(1)
  })
}
