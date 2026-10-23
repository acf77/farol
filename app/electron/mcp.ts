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
 * harness runs the pipelines the agent selects, and `delegate` is offered
 * instead.
 */

import { z } from 'zod'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { errorMessage } from '../shared/jev'
import { AI_PROVIDERS } from '../shared/ai'
import { DELEGATE_ENV, servedTools, servesPipelineTools, TASK_ENV, TOKEN_ENV } from '../shared/mcp-config'
import { requestBridge } from './bridge-client'

const APP_DOWN =
  'Farol is not running, or this project is not open in it. Pipelines run inside the app so their progress is visible, so start Farol and open this project, then try again.'

const text = (s: string) => ({ content: [{ type: 'text' as const, text: s }] })
const fail = (s: string) => ({ isError: true, ...text(s) })

async function main(): Promise<void> {
  const cwd = process.cwd()
  const server = new McpServer({ name: 'farol', version: '1.0.0' })
  if (servesPipelineTools(process.env)) registerPipelineTools(server, cwd)
  else registerManagedTools(server)
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

function registerManagedTools(server: McpServer): void {
  const taskId = process.env[TASK_ENV] ?? ''
  const token = process.env[TOKEN_ENV] ?? ''
  const delegateId = process.env[DELEGATE_ENV] || undefined
  const tools = servedTools(process.env)
  if (tools.includes('approve')) registerApprove(server, taskId, token, delegateId)
  // Subagents cannot delegate further.
  if (delegateId || !tools.includes('delegate')) return
  server.registerTool(
    'delegate',
    {
      title: 'Delegate to a subagent',
      description:
        'Hand one piece of work to another coding agent (a different provider or model) and wait for it to finish. It works in this same checkout and may edit files; nothing else edits while it runs. Returns its summary and the files it changed. It cannot ask the user questions, run Farol pipelines, or delegate further. You still select validation pipelines yourself afterwards.',
      inputSchema: {
        provider: z.enum(AI_PROVIDERS).describe('Which coding CLI runs the subagent'),
        model: z.string().optional().describe("Model id for that provider; omit for the CLI's default"),
        task: z.string().min(1).describe('What the subagent should do, stated completely'),
        context: z.string().optional().describe('Anything it needs to know that is not in the files')
      },
      annotations: { readOnlyHint: false, destructiveHint: true }
    },
    async ({ provider, model, task, context }) => {
      const reply = await requestBridge({
        op: 'delegate',
        token,
        taskId,
        provider,
        task,
        ...(model ? { model } : {}),
        ...(context ? { context } : {})
      })
      if (!reply) return fail('Farol is not reachable, so the subagent could not start.')
      if (!reply.ok) return fail(reply.message)
      if (reply.op !== 'delegate') return fail('Unexpected reply from Farol')
      return reply.failed ? fail(reply.text) : text(reply.text)
    }
  )
}

/**
 * Claude's `--permission-prompt-tool`: Claude calls it before a tool that
 * needs permission and runs that tool only if the reply allows it. The reply
 * is JSON text, `{ behavior: 'allow', updatedInput }` or
 * `{ behavior: 'deny', message }`; a deny message reaches the agent as the
 * tool's error.
 */
function registerApprove(server: McpServer, taskId: string, token: string, delegateId: string | undefined): void {
  const answer = (body: { behavior: 'allow'; updatedInput: unknown } | { behavior: 'deny'; message: string }) =>
    text(JSON.stringify(body))
  server.registerTool(
    'approve',
    {
      title: 'Ask the developer',
      description: "Farol's permission prompt. Claude calls it itself before a tool that needs approval; do not call it directly.",
      inputSchema: {
        tool_name: z.string(),
        input: z.record(z.string(), z.unknown()).optional(),
        tool_use_id: z.string().optional()
      }
    },
    async ({ tool_name, input }) => {
      const reply = await requestBridge({
        op: 'approve',
        token,
        taskId,
        toolName: tool_name,
        input: input ?? {},
        ...(delegateId ? { delegateId } : {})
      })
      if (!reply || !reply.ok || reply.op !== 'approve') {
        return answer({ behavior: 'deny', message: 'Farol could not ask the developer, so this was not run.' })
      }
      return reply.allow
        ? answer({ behavior: 'allow', updatedInput: input ?? {} })
        : answer({ behavior: 'deny', message: reply.message ?? 'The developer declined this.' })
    }
  )
}

main().catch((err) => {
  // stdout is the protocol channel; diagnostics must go to stderr.
  process.stderr.write(`farol-mcp: ${errorMessage(err)}\n`)
  process.exit(1)
})
