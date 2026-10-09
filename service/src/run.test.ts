import { describe, expect, it, vi } from 'vitest'
import type { Pipeline, PipelineNode } from '../shared/types'
import type { RemoteWorkspace } from '../shared/remote'
import { aiStepNames, executePipeline, type ServiceEvent } from './run'

function node(id: string, cmd: string, after: string[] = [], extra: Partial<PipelineNode> = {}): PipelineNode {
  return { id, name: id, type: 'shell', cmd, after, x: 0, y: 0, ...extra }
}

function workspace(results: Record<string, { code?: number; out?: string }> = {}): RemoteWorkspace {
  return {
    summary: '',
    close: vi.fn(),
    exec: vi.fn(async (cmd: string, onChunk: (chunk: string) => void) => {
      const result = results[cmd] ?? {}
      if (result.out) onChunk(result.out)
      return result.code ?? 0
    })
  }
}

const run = (nodes: PipelineNode[], ws: RemoteWorkspace, signal = new AbortController().signal) => {
  const events: ServiceEvent[] = []
  const pipeline: Pipeline = { id: 'p', name: 'P', nodes }
  return { events, done: executePipeline(pipeline, ws, (e) => events.push(e), signal) }
}

describe('executePipeline', () => {
  it('runs steps in dependency order and passes named outputs to later steps', async () => {
    const ws = workspace({ 'echo hi': { out: 'hi\n' } })
    const { done } = run([node('a', 'echo hi', [], { as: 'greeting' }), node('b', 'say ${greeting}', ['a'])], ws)

    const summary = await done

    expect(summary.ok).toBe(true)
    expect(vi.mocked(ws.exec).mock.calls.map(([cmd]) => cmd)).toEqual(['echo hi', "say 'hi'"])
    expect(summary.steps.map((s) => s.nodeId)).toEqual(['a', 'b'])
  })

  it('skips the descendants of a failed gated step', async () => {
    const ws = workspace({ 'npm run lint': { code: 2 } })
    const { done, events } = run([node('lint', 'npm run lint'), node('test', 'npm test', ['lint'])], ws)

    const summary = await done

    expect(summary).toMatchObject({ ok: false, failedNodeId: 'lint' })
    expect(summary.steps[1]).toMatchObject({ nodeId: 'test', skipped: true })
    expect(ws.exec).toHaveBeenCalledTimes(1)
    expect(events).toContainEqual(expect.objectContaining({ type: 'step-end', nodeId: 'test', skipped: true }))
  })

  it('reports cancellation and leaves unstarted steps skipped', async () => {
    const abort = new AbortController()
    const ws: RemoteWorkspace = {
      summary: '',
      close: vi.fn(),
      exec: vi.fn(async () => {
        abort.abort()
        throw new Error('aborted')
      })
    }
    const { done } = run([node('a', 'sleep 60'), node('b', 'after', ['a'])], ws, abort.signal)

    const summary = await done

    expect(summary).toMatchObject({ ok: false, cancelled: true })
    expect(summary.steps.map((s) => s.code)).toEqual([130, 130])
  })
})

describe('aiStepNames', () => {
  it('lists the steps a sandbox cannot run', () => {
    const pipeline: Pipeline = {
      id: 'p',
      name: 'P',
      nodes: [node('a', 'ls'), { ...node('b', 'review'), type: 'ai', name: 'Review' }]
    }
    expect(aiStepNames(pipeline)).toEqual(['Review'])
  })
})
