import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runAcp, type AcpRunOptions } from './acp-run'

const agent = path.join(__dirname, '__fixtures__', 'fake-acp-agent.mjs')
let dir: string
let log: string

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'farol-acp-'))
  log = path.join(dir, 'log.jsonl')
})
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

const calls = () =>
  fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []

function run(fake: Record<string, unknown>, overrides: Partial<AcpRunOptions> = {}) {
  const seen = { text: '', tools: [] as unknown[], noise: '', sessions: [] as string[], usage: [] as number[] }
  const opts: AcpRunOptions = {
    bin: process.execPath,
    args: [agent],
    cwd: dir,
    env: { ...process.env, FAKE_ACP: JSON.stringify({ log, ...fake }) },
    prompt: 'do it',
    mode: 'build',
    mcpServers: [{ name: 'farol-chat', command: '/app', args: ['/mcp.js'], env: [{ name: 'A', value: '1' }] }],
    permission: vi.fn().mockResolvedValue(true),
    onText: (c) => (seen.text += c),
    onTool: (t) => seen.tools.push(t),
    onNoise: (c) => (seen.noise += c),
    onSession: (id) => seen.sessions.push(id),
    onUsage: (t) => seen.usage.push(t),
    onProcess: () => undefined,
    ...overrides
  }
  return { result: runAcp(opts), seen, opts }
}

describe('runAcp', () => {
  it('opens a session with the managed server, runs the prompt and reports it', async () => {
    const { result, seen } = run({ modes: ['build', 'plan'], permission: true })
    expect(await result).toEqual({ code: 0 })
    expect(seen.text).toBe('Ran it.')
    expect(seen.sessions).toEqual(['ses_1'])
    expect(seen.usage).toEqual([4321])
    expect(seen.tools).toEqual([
      { toolId: 'c1', name: 'bash', state: 'running' },
      { toolId: 'c1', name: 'bash', detail: 'echo hi', state: 'running' },
      { toolId: 'c1', name: 'bash', state: 'done' }
    ])
    const newSession = calls().find((c) => c.method === 'session/new')
    expect(newSession.params.mcpServers).toEqual([{ name: 'farol-chat', command: '/app', args: ['/mcp.js'], env: [{ name: 'A', value: '1' }] }])
    expect(calls().find((c) => c.method === 'session/set_config_option')?.params).toEqual({ sessionId: 'ses_1', configId: 'mode', value: 'build' })
    expect(calls().find((c) => c.permissionReply)?.permissionReply).toEqual({ outcome: { outcome: 'selected', optionId: 'once' } })
  })

  it('answers a permission request no when the developer declines', async () => {
    const permission = vi.fn().mockResolvedValue(false)
    const { result, seen } = run({ modes: ['build'], permission: true }, { permission })
    expect(await result).toEqual({ code: 0 })
    expect(permission).toHaveBeenCalledWith(expect.objectContaining({ kind: 'execute', rawInput: { command: 'echo hi' } }))
    expect(calls().find((c) => c.permissionReply)?.permissionReply).toEqual({ outcome: { outcome: 'selected', optionId: 'reject' } })
    expect(seen.text).toBe('Not allowed.')
  })

  it('switches to plan and sets the model', async () => {
    const { result } = run({ modes: ['build', 'plan'] }, { mode: 'plan', model: 'anthropic/claude-sonnet-5' })
    expect(await result).toEqual({ code: 0 })
    const sets = calls().filter((c) => c.method === 'session/set_config_option').map((c) => c.params)
    expect(sets).toEqual([
      { sessionId: 'ses_1', configId: 'mode', value: 'plan' },
      { sessionId: 'ses_1', configId: 'model', value: 'anthropic/claude-sonnet-5' }
    ])
  })

  it('refuses Plan when the CLI has no plan mode, before prompting', async () => {
    const { result, seen } = run({ modes: ['build'] }, { mode: 'plan' })
    expect(await result).toEqual({ code: 1 })
    expect(seen.text).toContain('cannot keep it read-only')
    expect(calls().some((c) => c.method === 'session/prompt')).toBe(false)
  })

  it('resumes the CLI session it is given', async () => {
    const { result, seen } = run({ modes: ['build'], resume: true }, { resume: 'ses_9' })
    expect(await result).toEqual({ code: 0 })
    expect(calls().find((c) => c.method === 'session/resume')?.params.sessionId).toBe('ses_9')
    expect(seen.sessions).toEqual(['ses_9'])
  })

  it('reports a session that cannot be resumed the way the controller retries on', async () => {
    const { result, seen } = run({ modes: ['build'], resume: true, resumeFails: true }, { resume: 'ses_9' })
    expect(await result).toEqual({ code: 1 })
    expect(seen.noise).toMatch(/session not found/i)
    expect(seen.text).toBe('')
  })

  it('says so when the CLI does not speak ACP, having reported nothing', async () => {
    const { result, seen } = run({ noAcp: true })
    expect(await result).toEqual({ code: 0, unsupported: true })
    expect(seen.text + seen.noise).toBe('')
    expect(seen.tools).toEqual([])
  })
})
