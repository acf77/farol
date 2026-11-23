/**
 * The `mcp` surface: the agent's CLI on its own, the way a developer runs it in
 * a terminal, with Farol's MCP server (`electron/mcp.ts`, unmodified) and no
 * Farol prompt. The server talks to the app over its bridge socket; here the
 * bench answers on that socket, running pipelines and Git actions the same way
 * the chat surface does. What this surface measures is whether the agent finds
 * and uses `run_pipeline` and the `git_*` tools from their descriptions alone.
 *
 * Claude Code only, for now: other CLIs read MCP servers from their own config files.
 */

import { spawn } from 'child_process'
import crypto from 'crypto'
import fs from 'fs'
import net from 'net'
import os from 'os'
import path from 'path'
import { fileURLToPath } from 'url'
import { aiEnv, resolveBin } from '../../electron/bin'
import { captureLimited, changedPaths } from '../../electron/delegate-snapshot'
import { currentBranch } from '../../electron/git'
import { openRouterAgent } from '../../electron/openrouter-agent'
import { effortArgv } from '../../shared/ai'
import { AgentStreamParser } from '../../shared/agent-stream'
import { BRIDGE_ENV, takeLines, type BridgeReply, type BridgeRequest } from '../../shared/bridge'
import { formatGitResult, parseGitAction } from '../../shared/git-action'
import { resolvePipeline, topoSort } from '../../shared/graph'
import type { McpServerEntry } from '../../shared/mcp-config'
import { BenchGit, BenchRunner, MemoryTodoStore, mcpRunReport, type AttemptClock } from '../farol'
import type { BenchCase, FinalStatus, Subject, ToolCall, Trace } from '../types'
import { claudeUsage, emptyUsage } from '../usage'
import { casePipelines, createWorkspace, disposeWorkspace, runAcceptance } from '../workspace'
import type { RunOptions } from './chat'

const MCP_SERVER = fileURLToPath(new URL('../../electron/mcp.ts', import.meta.url))

/** What one agent run did; the real CLI or, in tests, a scripted MCP client. */
export interface McpRun {
  text: string
  tools: ToolCall[]
  code: number
  session?: string
  timedOut?: boolean
}

export type McpAgent = (run: { repo: string; prompt: string; server: McpServerEntry; timeoutMs: number }) => Promise<McpRun>

/** Farol's MCP server, started by bun straight from its TypeScript source. */
export function farolMcpServer(socket: string): McpServerEntry {
  return { command: resolveBin('bun') ?? 'bun', args: [MCP_SERVER], env: { [BRIDGE_ENV]: socket } }
}

/** Plain Claude Code, as a terminal session would run it, with only Farol's MCP server. */
export function claudeAgent(subject: Subject): McpAgent {
  return ({ repo, prompt, server, timeoutMs }) =>
    new Promise((resolve) => {
      const bin = resolveBin('claude')
      if (!bin) {
        resolve({ text: 'claude is not installed', tools: [], code: 127 })
        return
      }
      const args = [
        '-p',
        '--output-format',
        'stream-json',
        '--verbose',
        ...effortArgv('claude', subject.effort),
        // Variadic; the next flag ends its list.
        '--mcp-config',
        JSON.stringify({ mcpServers: { farol: server } }),
        '--strict-mcp-config',
        '--permission-mode',
        'bypassPermissions',
        ...(subject.model ? ['--model', subject.model] : []),
        prompt
      ]
      const child = spawn(bin, args, { cwd: repo, env: aiEnv('claude', openRouterAgent()), stdio: ['ignore', 'pipe', 'pipe'], detached: true })
      const parser = new AgentStreamParser()
      let text = ''
      let stderr = ''
      let timedOut = false
      const tools = new Map<string, ToolCall>()
      const consume = (events: ReturnType<AgentStreamParser['push']>): void => {
        for (const event of events) {
          if (event.kind === 'text') text += `${text && !text.endsWith('\n') ? '\n' : ''}${event.text}\n`
          else if (event.kind === 'raw') text += event.text
          else if (event.kind === 'tool') {
            const detail = event.detail ?? tools.get(event.toolId)?.detail
            tools.set(event.toolId, { name: event.name, ...(detail ? { detail } : {}), state: event.state })
          }
        }
      }
      child.stdout.on('data', (chunk: Buffer) => consume(parser.push(chunk.toString())))
      child.stderr.on('data', (chunk: Buffer) => {
        stderr = (stderr + chunk.toString()).slice(-8000)
      })
      const timer = setTimeout(() => {
        timedOut = true
        try {
          if (child.pid) process.kill(-child.pid, 'SIGKILL')
        } catch {
          /* gone */
        }
      }, timeoutMs)
      child.on('close', (code) => {
        clearTimeout(timer)
        consume(parser.flush())
        if (code !== 0 && stderr.trim()) text += `\n[stderr] ${stderr.trim()}\n`
        resolve({
          text,
          tools: [...tools.values()],
          code: code ?? 1,
          ...(parser.sessionId ? { session: parser.sessionId } : {}),
          ...(timedOut ? { timedOut } : {})
        })
      })
    })
}

/** Answers the MCP server the way the app does in `handleBridge` (`electron/main.ts`). */
function bridge(socket: string, handle: (req: BridgeRequest) => Promise<BridgeReply>): Promise<net.Server> {
  const server = net.createServer((conn) => {
    let buffer = ''
    conn.on('data', (chunk) => {
      buffer += chunk.toString()
      const { lines, rest } = takeLines(buffer)
      buffer = rest
      for (const line of lines) {
        let req: BridgeRequest
        try {
          req = JSON.parse(line) as BridgeRequest
        } catch {
          continue
        }
        void handle(req)
          .catch((error): BridgeReply => ({ id: req.id, ok: false, message: error instanceof Error ? error.message : String(error) }))
          .then((reply) => conn.end(`${JSON.stringify(reply)}\n`))
      }
    })
    conn.on('error', () => undefined)
  })
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(socket, () => resolve(server))
  })
}

export async function runMcp(c: BenchCase, subject: Subject, opts: RunOptions & { agent?: McpAgent }): Promise<Trace> {
  const started = Date.now()
  const ws = createWorkspace(c, opts.root)
  const pipelines = casePipelines(c)
  const clock: AttemptClock = { finished: 0 }
  const runner = new BenchRunner(new Map(), clock, 'mcp')
  const git = new BenchGit(ws.repo, true, clock, 'mcp')
  // Sockets have short path limits, so this one lives in the system temp folder.
  const socket = path.join(os.tmpdir(), `farol-bench-${crypto.randomBytes(6).toString('hex')}.sock`)
  const server = await bridge(socket, async (req) => {
    if (req.op === 'list') {
      return {
        id: req.id,
        ok: true,
        op: 'list',
        pipelines: pipelines.map((p) => ({ id: p.id, name: p.name, steps: (topoSort(p.nodes) ?? p.nodes).map((n) => `${n.name || n.id} (${n.type})`) }))
      }
    }
    if (req.op === 'run') {
      const found = resolvePipeline(pipelines, req.pipeline)
      if (!found.ok) {
        const detail = found.candidates.length ? `\nAvailable:\n- ${found.candidates.join('\n- ')}` : ''
        return { id: req.id, ok: false, message: found.message + detail }
      }
      const branch = (await currentBranch(ws.repo)) ?? '(no branch)'
      const result = await runner.run(found.pipeline, ws.repo, branch)
      return { id: req.id, ok: true, op: 'run', text: mcpRunReport(found.pipeline, branch, result), failed: !result.ok }
    }
    if (req.op === 'git') {
      const action = parseGitAction(req.action)
      if ('error' in action) return { id: req.id, ok: false, message: action.error }
      const result = await git.run(ws.repo, action, { branch: await currentBranch(ws.repo), tree: undefined, anyTree: true })
      return { id: req.id, ok: true, op: 'git', text: formatGitResult(action.action, result), failed: !result.ok }
    }
    return { id: req.id, ok: false, message: `The bench does not answer ${req.op}.` }
  })

  const tree = async (): Promise<string | undefined> => (await captureLimited(ws.repo).catch(() => undefined))?.tree
  const before = await tree()
  const agent = opts.agent ?? claudeAgent(subject)
  let run: McpRun
  let error: string | undefined
  try {
    run = await agent({ repo: ws.repo, prompt: c.prompt, server: farolMcpServer(socket), timeoutMs: opts.timeoutMs })
  } catch (err) {
    error = err instanceof Error ? err.message : String(err)
    run = { text: '', tools: [], code: 1 }
  }
  server.close()
  fs.rmSync(socket, { force: true })
  const after = await tree()
  const changedFiles = before && after && before !== after ? await changedPaths(ws.repo, before, after).catch(() => []) : []
  const status: FinalStatus = error ? 'error' : run.timedOut ? 'timeout' : run.code === 0 ? 'completed' : 'failed'
  opts.log?.(`  [${c.id}] ${status}`)

  const trace: Trace = {
    caseId: c.id,
    subject: subject.label,
    trial: opts.trial,
    surface: 'mcp',
    status,
    statusMessage: error ?? (run.timedOut ? 'timed out' : `exit ${run.code}`),
    attempts: [
      { index: 0, prompt: c.prompt, text: run.text, tools: run.tools, exitCode: run.code, durationMs: Date.now() - started, changedFiles, selection: null }
    ],
    pipelineRuns: runner.runs,
    gitActions: git.actions,
    todoSaves: [],
    todosBefore: c.todos ?? [],
    todosAfter: new MemoryTodoStore(ws.repo, c.todos).current(ws.repo),
    questionsAsked: 0,
    agentChangedFiles: changedFiles.sort(),
    ...(after ? { finalTree: after } : {}),
    acceptance: await runAcceptance(c, ws.repo),
    catalog: pipelines.map((p) => ({ id: p.id, cmds: p.nodes.flatMap((n) => (n.type === 'shell' && n.cmd ? [n.cmd] : [])) })),
    usage: run.session && !opts.agent ? claudeUsage([run.session]) : emptyUsage(),
    durationMs: Date.now() - started,
    ...(error ? { error } : {})
  }
  if (!opts.keep) disposeWorkspace(ws)
  return trace
}
