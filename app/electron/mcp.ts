/**
 * Farol's MCP server: lets a coding agent list this project's pipelines
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
 *
 * Managed Chat starts this same script as `farol-chat` (see
 * `shared/mcp-config.ts`). There the pipeline tools are left out, because the
 * harness runs the pipelines the agent selects.
 */

import { z } from 'zod'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { errorMessage } from '../shared/jev'
import { servesPipelineTools } from '../shared/mcp-config'
import { requestBridge } from './bridge-client'

const APP_DOWN =
  'Farol is not running, or this project is not open in it. Pipelines run inside the app so their progress is visible, so start Farol and open this project, then try again.'

const text = (s: string) => ({ content: [{ type: 'text' as const, text: s }] })
const fail = (s: string) => ({ isError: true, ...text(s) })

async function main(): Promise<void> {
  const cwd = process.cwd()
  const server = new McpServer({ name: 'farol', version: '1.0.0' })
  if (servesPipelineTools(process.env)) registerPipelineTools(server, cwd)
  await server.connect(new StdioServerTransport())
}

function registerPipelineTools(server: McpServer, cwd: string): void {
  server.registerTool(
    'list_pipelines',
    {
      title: 'List pipelines',
      description:
        "List this project's Farol pipelines. Call this before run_pipeline to learn the available names and ids.",
      inputSchema: {},
      annotations: { readOnlyHint: true }
    },
    async () => {
      const reply = await requestBridge({ op: 'list', cwd })
      if (!reply) return fail(APP_DOWN)
      if (!reply.ok) return fail(reply.message)
      if (reply.op !== 'list') return fail('Unexpected reply from Farol')
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
        "Run a Farol pipeline by name or id and wait for it to finish. Returns each step's result, with the output of any step that failed. Runs shell commands in the project, and is visible in the Farol window while it runs.",
      inputSchema: {
        pipeline: z.string().describe('Pipeline name or id, as reported by list_pipelines')
      },
      annotations: { readOnlyHint: false, destructiveHint: true }
    },
    async ({ pipeline }) => {
      const reply = await requestBridge({ op: 'run', cwd, pipeline })
      if (!reply) return fail(APP_DOWN)
      if (!reply.ok) return fail(reply.message)
      if (reply.op !== 'run') return fail('Unexpected reply from Farol')
      return reply.failed ? fail(reply.text) : text(reply.text)
    }
  )
}

main().catch((err) => {
  // stdout is the protocol channel; diagnostics must go to stderr.
  process.stderr.write(`farol-mcp: ${errorMessage(err)}\n`)
  process.exit(1)
})
