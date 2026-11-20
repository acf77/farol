import { EventEmitter } from 'events'
import { PassThrough } from 'stream'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentTaskEvent, AgentTaskRequest } from '../shared/types'

const { spawn, resolveBinFrom } = vi.hoisted(() => ({ spawn: vi.fn(), resolveBinFrom: vi.fn() }))
vi.mock('child_process', async (original) => ({ ...await original<typeof import('child_process')>(), spawn }))
vi.mock('./bin', () => ({ aiEnv: () => ({}), resolveBin: (name: string) => name, resolveBinFrom }))
vi.mock('./jev', () => ({ selectPipelines: async () => null, selectTools: async () => null }))
vi.mock('./backoff', () => ({ backoffWait: async () => {} }))

import { AgentController } from './agent-controller'

const request = (provider: AgentTaskRequest['provider'], mode: 'build' | 'plan'): AgentTaskRequest => ({
  id: 'git-policy', provider, mode, prompt: 'Read the project', cwd: '/missing/farol-project',
  checkout: '/missing/farol-project', branch: 'main', maxAttempts: 1,
  pipelines: [{ id: 'check', name: 'Check', nodes: [{ id: 'check', name: 'Check', type: 'shell', cmd: 'true', after: [], x: 0, y: 0 }] }]
})

beforeEach(() => {
  spawn.mockReset()
  resolveBinFrom.mockReset().mockReturnValue('/fake/claude')
})

describe('managed Git execution boundary', () => {
  it('stops unsupported providers before binary lookup, ACP, or process launch', async () => {
    for (const provider of ['codex', 'cursor', 'opencode', 'omp', 'openrouter'] as const) {
      for (const mode of ['build', 'plan'] as const) {
        const events: AgentTaskEvent[] = []
        const runner = { run: vi.fn() }
        const controller = new AgentController(runner, (event) => events.push(event))
        controller.start({ ...request(provider, mode), autoApprove: false })
        await vi.waitFor(() => expect(events.some((event) => event.kind === 'status' && event.status === 'needs-attention')).toBe(true))
        expect(events.some((event) => event.kind === 'output' && event.chunk.includes('cannot enforce the Git action limit'))).toBe(true)
        expect(runner.run).not.toHaveBeenCalled()
      }
    }
    expect(resolveBinFrom).not.toHaveBeenCalled()
    expect(spawn).not.toHaveBeenCalled()
  })

  it('starts a supported provider with restricted tools after selector fallback', async () => {
    spawn.mockImplementation(() => {
      const proc = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough() })
      queueMicrotask(() => {
        proc.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', result: 'FAROL_PIPELINES: []' }) + '\n')
        proc.emit('close', 0)
      })
      return proc
    })
    const events: AgentTaskEvent[] = []
    const controller = new AgentController({ run: vi.fn() }, (event) => events.push(event))
    controller.start(request('claude', 'build'))
    await vi.waitFor(() => expect(events.some((event) => event.kind === 'status' && event.status === 'completed')).toBe(true))
    expect(spawn).toHaveBeenCalledTimes(1)
    const [bin, args] = spawn.mock.calls[0] as [string, string[]]
    expect(bin).toBe('/fake/claude')
    expect(args).toContain('--restricted')
    expect(args).toContain('--strict-mcp-config')
    expect(args[args.indexOf('--tools') + 1]).toContain('Edit')
    expect(args[args.indexOf('--tools') + 1]).not.toContain('Bash')
    expect(args).not.toContain('bypassPermissions')
  })

  it('applies the same limit to child agents and refuses an unsupported child before launch', async () => {
    const parent = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough() })
    spawn.mockReturnValueOnce(parent).mockImplementation(() => {
      const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough() })
      queueMicrotask(() => {
        child.stdout.write(JSON.stringify({ type: 'result', result: 'Read the files.' }) + '\n')
        child.emit('close', 0)
      })
      return child
    })
    const events: AgentTaskEvent[] = []
    const controller = new AgentController({ run: vi.fn() }, (event) => events.push(event))
    controller.start(request('claude', 'plan'))
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledTimes(1))
    const refused = await controller.delegate('git-policy', { provider: 'codex', task: 'Read the files' })
    expect(refused).toMatchObject({ ok: true, failed: true })
    expect(spawn).toHaveBeenCalledTimes(1)
    const allowed = await controller.delegate('git-policy', { provider: 'claude', task: 'Read the files' })
    expect(allowed).toMatchObject({ ok: true, failed: false })
    expect(spawn).toHaveBeenCalledTimes(2)
    const args = spawn.mock.calls[1][1] as string[]
    expect(args).toContain('--restricted')
    expect(args).toContain('--strict-mcp-config')
    expect(args[args.indexOf('--tools') + 1]).not.toMatch(/Bash|Write|Agent/)
    parent.stdout.write(JSON.stringify({ type: 'result', result: 'FAROL_PIPELINES: []' }) + '\n')
    parent.emit('close', 0)
    await vi.waitFor(() => expect(events.some((event) => event.kind === 'status' && event.status === 'completed')).toBe(true))
  })
})
