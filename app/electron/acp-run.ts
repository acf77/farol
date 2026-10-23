/**
 * One managed Chat run over ACP (see `shared/acp.ts`): start the CLI's ACP
 * server, open or resume a session with Farol's managed MCP server, set the
 * mode and model, send the prompt, and report what the agent says and does
 * through the same callbacks the JSON stream runs use.
 */

import { spawn, type ChildProcess } from 'child_process'
import { StringDecoder } from 'string_decoder'
import type { AgentMode } from '../shared/ai'
import {
  ACP_PROTOCOL_VERSION,
  acpExitCode,
  acpModeValue,
  acpPermissionChoice,
  acpToolDetail,
  acpToolName,
  acpToolState,
  type AcpConfigOption,
  type AcpMcpServer,
  type AcpPermissionOption,
  type AcpToolCall
} from '../shared/acp'

/** How long the server may take to answer `initialize` before Farol gives up on ACP for this CLI. */
const INITIALIZE_TIMEOUT_MS = 30_000

export interface AcpRunOptions {
  bin: string
  args: string[]
  cwd: string
  env: NodeJS.ProcessEnv
  prompt: string
  mode: AgentMode
  model?: string
  /** The CLI session to continue. */
  resume?: string
  mcpServers: AcpMcpServer[]
  /** Whether a tool call may run; the developer's answer, or auto-approve's. */
  permission(call: AcpToolCall): Promise<boolean>
  onText(chunk: string): void
  onTool(event: { toolId: string; name: string; detail?: string; state: 'running' | 'done' | 'error' }): void
  /** Diagnostics: held back from the transcript, watched for provider failures. */
  onNoise(chunk: string): void
  onSession(id: string): void
  onUsage?(inputTokens: number): void
  onProcess(proc: ChildProcess | null): void
}

/**
 * `unsupported` means the CLI never spoke ACP (an older build), so the caller
 * can fall back to its JSON mode; nothing has been reported in that case.
 */
export type AcpRunResult = { code: number; unsupported?: true }

interface Pending {
  resolve(message: Record<string, unknown>): void
}

export function runAcp(opts: AcpRunOptions): Promise<AcpRunResult> {
  return new Promise((resolve) => {
    let proc: ChildProcess
    try {
      proc = spawn(opts.bin, opts.args, { cwd: opts.cwd, env: opts.env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
    } catch (error) {
      opts.onNoise(`farol: ${error instanceof Error ? error.message : String(error)}\n`)
      resolve({ code: 127 })
      return
    }
    opts.onProcess(proc)
    let settled = false
    let initialized = false
    const finish = (result: AcpRunResult): void => {
      if (settled) return
      settled = true
      opts.onProcess(null)
      if (proc.exitCode === null && !proc.killed) proc.kill()
      resolve(result)
    }

    let nextId = 0
    const pending = new Map<number, Pending>()
    const send = (message: Record<string, unknown>): void => {
      if (proc.stdin?.writable) proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`)
    }
    const call = (method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> =>
      new Promise((done) => {
        const id = ++nextId
        pending.set(id, { resolve: done })
        send({ id, method, params })
      })

    // Tool names arrive on the first update; later updates for the same call may omit them.
    const names = new Map<string, string>()
    const onUpdate = (update: Record<string, unknown>): void => {
      const kind = update.sessionUpdate
      if (kind === 'agent_message_chunk') {
        const content = update.content as Record<string, unknown> | undefined
        if (content?.type === 'text' && typeof content.text === 'string') opts.onText(content.text)
        return
      }
      if (kind !== 'tool_call' && kind !== 'tool_call_update') return
      const tool = update as AcpToolCall
      const toolId = typeof tool.toolCallId === 'string' ? tool.toolCallId : ''
      const state = acpToolState(tool.status)
      if (!toolId || !state) return
      const name = acpToolName(tool, names.get(toolId))
      if (!names.has(toolId) || (name !== 'tool' && names.get(toolId) === 'tool')) names.set(toolId, name)
      const detail = acpToolDetail(tool)
      opts.onTool({ toolId, name: names.get(toolId) ?? name, ...(detail ? { detail } : {}), state })
    }
    const onPermission = async (id: unknown, params: Record<string, unknown>): Promise<void> => {
      const options = Array.isArray(params.options) ? (params.options as AcpPermissionOption[]) : []
      const allow = await opts.permission((params.toolCall ?? {}) as AcpToolCall).catch(() => false)
      const optionId = acpPermissionChoice(options, allow)
      send({ id, result: { outcome: optionId ? { outcome: 'selected', optionId } : { outcome: 'cancelled' } } })
    }

    const decoder = new StringDecoder('utf8')
    let buffer = ''
    proc.stdout?.on('data', (chunk: Buffer) => {
      buffer += decoder.write(chunk)
      let newline: number
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline).trim()
        buffer = buffer.slice(newline + 1)
        if (!line) continue
        let message: Record<string, unknown>
        try {
          message = JSON.parse(line) as Record<string, unknown>
        } catch {
          opts.onNoise(`${line}\n`)
          continue
        }
        const method = typeof message.method === 'string' ? message.method : undefined
        if (!method && typeof message.id === 'number') {
          pending.get(message.id)?.resolve(message)
          pending.delete(message.id)
        } else if (method === 'session/update') {
          const update = (message.params as Record<string, unknown> | undefined)?.update
          if (update && typeof update === 'object') onUpdate(update as Record<string, unknown>)
        } else if (method === 'session/request_permission') {
          void onPermission(message.id, (message.params ?? {}) as Record<string, unknown>)
        } else if (method && message.id !== undefined) {
          // Farol offers no file system or terminal to the agent; it uses its own tools.
          send({ id: message.id, error: { code: -32601, message: `Farol does not support ${method}` } })
        }
      }
    })
    const stderr = new StringDecoder('utf8')
    proc.stderr?.on('data', (chunk: Buffer) => opts.onNoise(stderr.write(chunk)))
    proc.on('error', (error) => {
      if (!initialized) finish({ code: 127, unsupported: true })
      else {
        opts.onNoise(`farol: ${error.message}\n`)
        finish({ code: 127 })
      }
    })
    proc.on('close', (code) => {
      for (const waiter of pending.values()) waiter.resolve({ error: { message: 'The agent exited.' } })
      pending.clear()
      finish(initialized ? { code: code || 1 } : { code: code ?? 1, unsupported: true })
    })

    const failed = (message: Record<string, unknown>): string | undefined => {
      const error = message.error as Record<string, unknown> | undefined
      return error ? String(error.message ?? 'ACP request failed') : undefined
    }

    void (async () => {
      const timer = setTimeout(() => finish({ code: 1, unsupported: true }), INITIALIZE_TIMEOUT_MS)
      const init = await call('initialize', {
        protocolVersion: ACP_PROTOCOL_VERSION,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false }
      })
      clearTimeout(timer)
      if (settled) return
      if (failed(init)) return finish({ code: 1, unsupported: true })
      initialized = true
      const caps = ((init.result as Record<string, unknown> | undefined)?.agentCapabilities ?? {}) as Record<string, unknown>
      const canResume = !!(caps.sessionCapabilities as Record<string, unknown> | undefined)?.resume

      let sessionId: string | undefined
      let configOptions: AcpConfigOption[] | undefined
      if (opts.resume) {
        if (!canResume) {
          opts.onNoise('session not found: this CLI cannot resume over ACP\n')
          return finish({ code: 1 })
        }
        const resumed = await call('session/resume', { sessionId: opts.resume, cwd: opts.cwd, mcpServers: opts.mcpServers })
        if (failed(resumed)) {
          // The controller retries once on a new session with the whole history.
          opts.onNoise(`session not found: ${failed(resumed)}\n`)
          return finish({ code: 1 })
        }
        sessionId = opts.resume
        configOptions = (resumed.result as Record<string, unknown> | undefined)?.configOptions as AcpConfigOption[] | undefined
      } else {
        const created = await call('session/new', { cwd: opts.cwd, mcpServers: opts.mcpServers })
        const result = created.result as Record<string, unknown> | undefined
        if (failed(created) || typeof result?.sessionId !== 'string') {
          opts.onNoise(`${failed(created) ?? 'The agent did not open a session.'}\n`)
          return finish({ code: 1 })
        }
        sessionId = result.sessionId
        configOptions = result.configOptions as AcpConfigOption[] | undefined
      }
      if (settled) return
      opts.onSession(sessionId)

      const mode = acpModeValue(opts.mode, configOptions)
      if (!mode && opts.mode === 'plan') {
        // No read-only mode to switch to: refuse rather than plan with write access.
        opts.onText('farol: this CLI offers no Plan mode over ACP, so Farol cannot keep it read-only.\n')
        return finish({ code: 1 })
      }
      if (mode) {
        const set = await call('session/set_config_option', { sessionId, configId: 'mode', value: mode })
        if (failed(set)) {
          opts.onText(`farol: could not switch the agent to ${mode} mode: ${failed(set)}\n`)
          return finish({ code: 1 })
        }
      }
      if (opts.model) {
        const set = await call('session/set_config_option', { sessionId, configId: 'model', value: opts.model })
        if (failed(set)) {
          opts.onText(`farol: ${failed(set)}\n`)
          return finish({ code: 1 })
        }
      }
      if (settled) return

      const reply = await call('session/prompt', { sessionId, prompt: [{ type: 'text', text: opts.prompt }] })
      const error = failed(reply)
      if (error) {
        opts.onText(`${error}\n`)
        return finish({ code: 1 })
      }
      const result = (reply.result ?? {}) as Record<string, unknown>
      const usage = result.usage as Record<string, unknown> | undefined
      if (typeof usage?.inputTokens === 'number') opts.onUsage?.(usage.inputTokens)
      finish({ code: acpExitCode(result.stopReason) })
    })()
  })
}
