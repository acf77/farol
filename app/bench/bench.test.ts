import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterAll, describe, expect, it, vi } from 'vitest'

// No Electron here: user data goes to a temp folder, so no saved key reaches a run.
vi.mock('electron', () => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'farol-bench-test-userdata-'))
  return {
    app: { getPath: () => userData, getVersion: () => '0.0.0-test', isPackaged: false },
    safeStorage: { isEncryptionAvailable: () => false },
    shell: { openExternal: async () => undefined }
  }
})
vi.mock('../electron/jev', () => ({
  selectPipelines: vi.fn().mockResolvedValue(null),
  selectTools: vi.fn().mockResolvedValue(null)
}))
vi.mock('../electron/backoff', () => ({ backoffDelayMs: () => 0, backoffWait: () => Promise.resolve() }))

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import type { AgentExecutor } from '../electron/agent-controller'
import { resolveBin } from '../electron/bin'
import { CASES, catalogId, selectCases } from './cases'
import { attemptSelection, finalMarker, grade, retryReason, todoUnchanged, validates } from './grade'
import { runChat, scriptedAgent } from './harness/chat'
import { runMcp, type McpAgent } from './harness/mcp'
import { parseSubject } from './subject'
import { markdownReport } from './report'
import type { BenchCase, ToolCall, Trace } from './types'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'farol-bench-test-'))
afterAll(() => fs.rmSync(root, { recursive: true, force: true }))

const subject = parseSubject('chat/claude:scripted')
const byId = (id: string): BenchCase => {
  const found = CASES.find((c) => c.id === id)
  if (!found) throw new Error(id)
  return found
}

/** An agent that says `turns[i]` on attempt i, after running `act` (edits, tool calls). */
function agent(turns: ((prompt: string, repo: string) => { text: string; tools?: { name: string; detail?: string }[] })[]): AgentExecutor {
  let i = 0
  return async (request, prompt, onOutput, onTool) => {
    const turn = turns[Math.min(i, turns.length - 1)](prompt, request.cwd)
    i += 1
    turn.tools?.forEach((tool, n) => onTool?.({ toolId: `t${i}-${n}`, name: tool.name, ...(tool.detail ? { detail: tool.detail } : {}), state: 'done' }))
    onOutput(`${turn.text}\n`)
    return 0
  }
}

const run = (c: BenchCase, executor: AgentExecutor) => runChat(c, subject, { trial: 1, root, timeoutMs: 30_000, executor })

describe('every case', () => {
  it('has a unique id and at least one check of its own', () => {
    expect(new Set(CASES.map((c) => c.id)).size).toBe(CASES.length)
    for (const c of CASES) expect(c.checks.length, c.id).toBeGreaterThan(0)
  })

  for (const c of CASES) {
    it(`${c.id}: the reference passes every check`, async () => {
      const result = grade(c, await run(c, scriptedAgent(c.reference)))
      const failed = result.checks.filter((chk) => !chk.pass).map((chk) => `${chk.id}: ${chk.detail}`)
      expect(failed).toEqual([])
      expect(result.trace.attempts).toHaveLength(1)
    }, 60_000)
  }
})

describe('a sloppy agent fails the right checks', () => {
  it('running the tests itself fails no-self-run', async () => {
    const c = byId('pipelines/failing-tests')
    const executor = agent([
      (prompt, repo) => {
        const file = path.join(repo, 'src/format.mjs')
        fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('value > 1024', 'value >= 1024'))
        return { text: `Fixed.\nFAROL_PIPELINES: ["${catalogId(prompt, 'unit-tests')}"]`, tools: [{ name: 'Bash', detail: 'node --test test/format.test.mjs' }] }
      }
    ])
    const result = grade(c, await run(c, executor))
    expect(result.pass).toBe(false)
    expect(result.checks.find((chk) => chk.id === 'pipelines.no-self-run')).toMatchObject({ pass: false, critical: true })
    expect(result.checks.find((chk) => chk.id === 'outcome.acceptance')?.pass).toBe(true)
  }, 60_000)

  it('a bad marker costs a format retry, and a change validated by nothing fails', async () => {
    const c = byId('pipelines/bugfix')
    const executor = agent([
      (_prompt, repo) => {
        const file = path.join(repo, 'src/slugify.mjs')
        fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace(".replace(/\\s/g, '-')", ".replace(/[\\s-]+/g, '-').replace(/^-+|-+$/g, '')"))
        return { text: 'Fixed.\nFAROL_PIPELINES: unit-tests' }
      },
      () => ({ text: 'Sorry.\nFAROL_PIPELINES: []' })
    ])
    const result = grade(c, await run(c, executor))
    expect(result.trace.attempts.map((a) => a.reason)).toEqual([undefined, 'invalid-pipeline-selection'])
    expect(result.checks.find((chk) => chk.id === 'protocol.no-format-retries')?.pass).toBe(false)
    expect(result.checks.find((chk) => chk.id === 'pipelines.validates:unit-tests')?.pass).toBe(false)
    expect(result.pass).toBe(false)
  }, 60_000)

  it('a lint failure goes through the repair loop and is graded on the final code', async () => {
    const c = byId('pipelines/feature')
    const first = c.reference
    const executor = agent([
      (prompt, repo) => {
        const said = first({ repo, attempt: 0, prompt })
        // Undo the JSDoc so Lint fails the first time.
        const file = path.join(repo, 'src/truncate.mjs')
        fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace(/\/\*\*[\s\S]*?\*\/\n/, ''))
        return { text: typeof said === 'string' ? said : said.text }
      },
      (prompt, repo) => {
        const file = path.join(repo, 'src/truncate.mjs')
        fs.writeFileSync(file, `/** Shorten text. */\n${fs.readFileSync(file, 'utf8')}`)
        return { text: `Added the JSDoc.\nFAROL_PIPELINES: ["${catalogId(prompt, 'lint')}"]` }
      }
    ])
    const result = grade(c, await run(c, executor))
    expect(result.trace.attempts.map((a) => a.reason)).toEqual([undefined, 'validation-failed'])
    expect(result.trace.pipelineRuns.find((r) => r.id === 'lint' && !r.ok)).toBeTruthy()
    // Lint re-ran on the final code; the tests only ran before the repair, so they did not see it.
    const failed = result.checks.filter((chk) => !chk.pass).map((chk) => chk.id)
    expect(failed).toEqual(['pipelines.validates:unit-tests+lint', 'pipelines.validates:docs'])
  }, 60_000)

  it('a commit the hook blocks is retried after the agent repairs it', async () => {
    const c = byId('git/pre-commit-hook')
    const executor = agent([
      (prompt, repo) => {
        const file = path.join(repo, 'src/format.mjs')
        fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace("'MB']", "'MB', 'GB']"))
        return { text: `Added GB.\nFAROL_GIT: {"action":"commit","message":"formatBytes: add GB"}\nFAROL_PIPELINES: ["${catalogId(prompt, 'unit-tests')}"]` }
      },
      (prompt, repo) => {
        const file = path.join(repo, 'CHANGELOG.md')
        fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('## Unreleased\n', '## Unreleased\n\n- formatBytes: add GB.\n'))
        return { text: `Added the changelog line.\nFAROL_GIT: {"action":"commit","message":"formatBytes: add GB"}\nFAROL_PIPELINES: ["${catalogId(prompt, 'unit-tests')}"]` }
      }
    ])
    const result = grade(c, await run(c, executor))
    expect(result.trace.attempts.map((a) => a.reason)).toEqual([undefined, 'git-hook-blocked'])
    expect(result.trace.gitActions.map((g) => [g.request.action, g.ok, g.hookBlocked])).toEqual([
      ['commit', false, true],
      ['commit', true, false]
    ])
    expect(result.pass).toBe(true)
    expect(result.checks.filter((chk) => !chk.pass).map((chk) => chk.id)).toEqual(['git.first-try'])
  }, 60_000)

  it('committing from the shell, or skipping FAROL_GIT, fails the Git checks', async () => {
    const c = byId('git/commit')
    const executor = agent([
      (prompt, repo) => {
        const file = path.join(repo, 'src/format.mjs')
        fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace("'MB']", "'MB', 'GB']"))
        return { text: `Done.\nFAROL_PIPELINES: ["${catalogId(prompt, 'unit-tests')}"]`, tools: [{ name: 'Bash', detail: 'git commit -am "add GB"' }] }
      }
    ])
    const result = grade(c, await run(c, executor))
    const failed = result.checks.filter((chk) => !chk.pass).map((chk) => chk.id)
    expect(failed).toEqual(expect.arrayContaining(['git.actions:commit', 'git.no-self-git']))
  }, 60_000)

  it('a todo line sent last is ignored by Farol, so the list never changes', async () => {
    const c = byId('todos/add')
    const executor = agent([
      () => ({
        text: 'Added.\nFAROL_PIPELINES: []\nFAROL_TODOS: [{"content":"Add a truncate helper","status":"pending","priority":"medium"},{"content":"Write a migration guide for v2","status":"pending","priority":"high"}]'
      })
    ])
    const result = grade(c, await run(c, executor))
    expect(result.trace.todoSaves).toEqual([])
    expect(result.checks.find((chk) => chk.id === 'todos.saved')?.pass).toBe(false)
    expect(result.checks.find((chk) => chk.id === 'protocol.final-line')?.pass).toBe(false)
  }, 60_000)

  it('a question is answered once, and the plan that follows is graded', async () => {
    const c = byId('plan/read-only')
    const question = { question: 'Which locales first?', header: 'Locales', options: [{ label: 'German', description: 'ß, ä, ö, ü' }, { label: 'Nordic', description: 'æ, ø, å' }], multiple: false }
    const executor = agent([
      () => ({ text: `One thing first.\nFAROL_QUESTIONS: ${JSON.stringify([question])}` }),
      () => ({ text: '1. Add a table.\n2. Apply it.\nFAROL_PLAN: finished' })
    ])
    const result = grade(c, await run(c, executor))
    expect(result.trace.questionsAsked).toBe(1)
    expect(result.trace.attempts.map((a) => a.reason)).toEqual([undefined, 'user'])
    expect(result.trace.attempts[1].prompt).toContain('The user dismissed the questions')
    expect(result.strict).toBe(true)
  }, 60_000)

  it('dropping the rest of the list when adding a todo fails todos.unchanged', async () => {
    const c = byId('todos/add')
    const executor = agent([() => ({ text: 'Added.\nFAROL_TODOS: [{"content":"Write a migration guide for v2","status":"pending","priority":"high"}]\nFAROL_PIPELINES: []' })])
    const result = grade(c, await run(c, executor))
    expect(result.checks.find((chk) => chk.id === todoUnchanged('Add a truncate helper').id)).toMatchObject({ pass: false })
  }, 60_000)
})

describe('readers', () => {
  it('classifies why Farol asked again', () => {
    expect(retryReason('Farol validation attempt 2 failed. Fix the code')).toBe('validation-failed')
    expect(retryReason('Farol could not validate because your pipeline selection was invalid: x')).toBe('invalid-pipeline-selection')
    expect(retryReason('Farol could not validate because you bypassed pipelines: x')).toBe('self-ran-pipeline')
    expect(retryReason('Git commit failed: x\nFix what it reports, then send the FAROL_GIT: line again.')).toBe('git-hook-blocked')
    expect(retryReason('User request: carry on')).toBe('user')
  })

  it('reads selections and final lines the way Farol does', () => {
    const ids = new Map([['repo-x:managed-pipeline:lint', 'lint']])
    expect(attemptSelection({ text: 'x\nFAROL_PIPELINES: ["repo-x:managed-pipeline:lint"]' }, ids)).toEqual(['lint'])
    expect(attemptSelection({ text: '```\nFAROL_PIPELINES: ["a"]\n```' }, ids)).toBeNull()
    expect(finalMarker('ok\nFAROL_PIPELINES: []\n\n')).toBe('FAROL_PIPELINES:')
    expect(finalMarker('ok\nFAROL_PIPELINES: []\nThanks!')).toBeUndefined()
  })

  it('validates() wants a run on the final tree', () => {
    const trace = { finalTree: 'b', pipelineRuns: [{ id: 'lint', ok: true, afterAttempt: 1, via: 'chat', tree: 'a' }], attempts: [] } as unknown as Trace
    expect(validates(['lint']).grade(trace)).toMatchObject({ pass: false })
    expect(validates(['lint']).grade({ ...trace, finalTree: 'a' })).toMatchObject({ pass: true })
  })

  it('selects cases by glob and reads subjects', () => {
    expect(selectCases(['git/*']).every((c) => c.id.startsWith('git/'))).toBe(true)
    expect(() => selectCases(['nope'])).toThrow(/No case matches/)
    expect(parseSubject('claude:claude-opus-5-5@high')).toMatchObject({ surface: 'chat', provider: 'claude', model: 'claude-opus-5-5', effort: 'high' })
    expect(parseSubject('mcp/claude')).toMatchObject({ surface: 'mcp', label: 'mcp/claude' })
    expect(() => parseSubject('mcp/codex:gpt-5.6')).toThrow(/Claude Code only/)
  })

  it('writes a report', async () => {
    const c = byId('pipelines/question-only')
    const result = grade(c, await run(c, scriptedAgent(c.reference)))
    const md = markdownReport([result], { startedAt: 'now', farolVersion: '0', commit: 'abc', subjects: [subject.label], cases: [c.id], trials: 1 })
    expect(md).toContain('| chat/claude:scripted | 1/1 (100%)')
    expect(md).toContain('`pipelines/question-only` | ✅ 1/1')
  }, 60_000)
})

describe('the mcp surface', () => {
  const hasBun = !!resolveBin('bun')

  /** A terminal agent scripted as an MCP client of Farol's real server. */
  function mcpAgent(act: (call: (name: string, args?: Record<string, unknown>) => Promise<string>, repo: string) => Promise<void>): McpAgent {
    return async ({ repo, server }) => {
      const client = new Client({ name: 'farol-bench-test', version: '1.0.0' })
      await client.connect(new StdioClientTransport({ command: server.command, args: server.args, env: { ...process.env, ...server.env } as Record<string, string>, cwd: repo }))
      const tools: ToolCall[] = []
      const call = async (name: string, args: Record<string, unknown> = {}): Promise<string> => {
        const res = (await client.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean }
        tools.push({ name: `mcp__farol__${name}`, detail: JSON.stringify(args), state: res.isError ? 'error' : 'done' })
        return res.content.map((part) => part.text).join('\n')
      }
      try {
        await act(call, repo)
      } finally {
        await client.close()
      }
      return { text: 'Done.', tools, code: 0 }
    }
  }

  const fixSlugify = (repo: string): void => {
    const file = path.join(repo, 'src/slugify.mjs')
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace(".replace(/\\s/g, '-')", ".replace(/[\\s-]+/g, '-').replace(/^-+|-+$/g, '')"))
  }

  it.skipIf(!hasBun)('runs pipelines through the bridge, as the app would', async () => {
    const c = byId('pipelines/bugfix')
    let listed = ''
    let ran = ''
    const agent = mcpAgent(async (call, repo) => {
      listed = await call('list_pipelines')
      fixSlugify(repo)
      ran = await call('run_pipeline', { pipeline: 'Unit tests' })
    })
    const result = grade(c, await runMcp(c, parseSubject('mcp/claude'), { trial: 1, root, timeoutMs: 30_000, agent }))
    expect(listed).toContain('- Unit tests [id: unit-tests]')
    expect(ran).toContain('PASSED: Unit tests on main')
    expect(result.checks.filter((chk) => !chk.pass).map((chk) => chk.id)).toEqual([])
  }, 60_000)

  it.skipIf(!hasBun)('performs MCP Git actions in order, and grades a terminal agent that never validates', async () => {
    const c = byId('git/commit-push-pr')
    const agent = mcpAgent(async (call, repo) => {
      fixSlugify(repo)
      await call('git_commit', { message: 'slugify: collapse runs of dashes', files: ['src/slugify.mjs'] })
      await call('git_push')
      await call('git_create_pr', { base: 'main', title: 'slugify: collapse runs of dashes' })
    })
    const result = grade(c, await runMcp(c, parseSubject('mcp/claude'), { trial: 1, root, timeoutMs: 30_000, agent }))
    expect(result.trace.gitActions.map((g) => [g.request.action, g.ok])).toEqual([
      ['commit', true],
      ['push', true],
      ['create_pr', true]
    ])
    expect(result.checks.filter((chk) => !chk.pass).map((chk) => chk.id)).toEqual(['pipelines.validates:unit-tests'])
    expect(result.pass).toBe(true)
  }, 60_000)
})
