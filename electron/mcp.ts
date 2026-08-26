/**
 * BuildFlow's MCP server: lets a coding agent list this project's pipelines
 * and run any of them.
 *
 * It owns no runner. Every request is forwarded over a local socket to the
 * running app, which executes the pipeline through its own runner — so the run
 * appears in the UI (run tab, streaming log, sidebar status) exactly as if a
 * person had clicked Run. With the app closed, the tools refuse rather than
 * quietly running a second copy of the pipeline somewhere the user cannot see.
 *
 * Runs asked for here are stamped `origin: 'agent'`, which stops the app
 * handing the failure back to an agent and looping.
 */

import net from 'net'
import { z } from 'zod'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { BRIDGE_ENV, takeLines, type BridgeAsk, type BridgeReply } from '../shared/bridge'

/** How long to wait for the app to accept a connection — not for the run. */
const CONNECT_TIMEOUT_MS = 5000

const APP_DOWN =
  'BuildFlow is not running, or this project is not open in it. Pipelines run inside the app so their progress is visible, so start BuildFlow and open this project, then try again.'

/**
 * Ask the running app to do the work. Resolves null when there is no app to
 * talk to; the caller turns that into a refusal.
 */
function askApp(req: BridgeAsk): Promise<BridgeReply | null> {
  const file = process.env[BRIDGE_ENV]
  if (!file) return Promise.resolve(null)
  return new Promise((resolve) => {
    let settled = false
    let connected = false
    let buffer = ''
    const done = (v: BridgeReply | null): void => {
      if (settled) return
      settled = true
      socket.destroy()
      resolve(v)
    }
    const socket = net.createConnection(file)
    socket.setTimeout(CONNECT_TIMEOUT_MS, () => {
      // Only the handshake is time-boxed: a pipeline legitimately takes minutes.
      if (!connected) done(null)
    })
    socket.on('connect', () => {
      connected = true
      socket.setTimeout(0)
      socket.write(JSON.stringify({ ...req, id: 1 }) + '\n')
    })
    socket.on('data', (chunk) => {
      buffer += chunk.toString()
      const { lines, rest } = takeLines(buffer)
      buffer = rest
      for (const line of lines) {
        try {
          done(JSON.parse(line) as BridgeReply)
        } catch {
          /* partial or malformed frame — keep reading */
        }
      }
    })
    socket.on('error', () => done(null))
    socket.on('close', () => done(null))
  })
}

const text = (s: string) => ({ content: [{ type: 'text' as const, text: s }] })
const fail = (s: string) => ({ isError: true, ...text(s) })

async function main(): Promise<void> {
  const cwd = process.cwd()
  const server = new McpServer({ name: 'buildflow', version: '1.0.0' })

  server.registerTool(
    'list_pipelines',
    {
      title: 'List pipelines',
      description:
        "List this project's BuildFlow pipelines. Call this before run_pipeline to learn the available names and ids.",
      inputSchema: {},
      annotations: { readOnlyHint: true }
    },
    async () => {
      const reply = await askApp({ op: 'list', cwd })
      if (!reply) return fail(APP_DOWN)
      if (!reply.ok) return fail(reply.message)
      if (reply.op !== 'list') return fail('Unexpected reply from BuildFlow')
      if (!reply.pipelines.length) return text(`No pipelines are configured in ${cwd}.`)
      const list = reply.pipelines
        .map((p) => `- ${p.name} [id: ${p.id}]\n  steps: ${p.steps.join(', ')}`)
        .join('\n')
      return text(`Pipelines in ${cwd}:\n${list}`)
    }
  )

  server.registerTool(
    'run_pipeline',
    {
      title: 'Run a pipeline',
      description:
        "Run a BuildFlow pipeline by name or id and wait for it to finish. Returns each step's result, with the output of any step that failed. Runs shell commands in the project, and is visible in the BuildFlow window while it runs.",
      inputSchema: {
        pipeline: z.string().describe('Pipeline name or id, as reported by list_pipelines')
      },
      annotations: { readOnlyHint: false, destructiveHint: true }
    },
    async ({ pipeline }) => {
      const reply = await askApp({ op: 'run', cwd, pipeline })
      if (!reply) return fail(APP_DOWN)
      if (!reply.ok) return fail(reply.message)
      if (reply.op !== 'run') return fail('Unexpected reply from BuildFlow')
      return reply.failed ? fail(reply.text) : text(reply.text)
    }
  )

  await server.connect(new StdioServerTransport())
}

main().catch((err) => {
  // stdout is the protocol channel; diagnostics must go to stderr.
  process.stderr.write(`buildflow-mcp: ${err instanceof Error ? err.message : String(err)}\n`)
  process.exit(1)
})
