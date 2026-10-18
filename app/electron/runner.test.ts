import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Pipeline, RunEvent } from '../shared/types'
import { quoteShellArg } from '../shared/graph'
import type { StepVerdict } from '../shared/verdict'

const { spawn, runGit, listGit, onData, onExit, verdictFromOutput } = vi.hoisted(() => ({
  spawn: vi.fn(),
  listGit: vi.fn<(cwd: string, args: string[], signal: AbortSignal) => Promise<string[]>>(),
  runGit: vi.fn<(cwd: string, args: string[], rel: string, signal: AbortSignal) => Promise<{ preview: string; truncated: boolean }>>(),
  onData: vi.fn<(listener: (chunk: string) => void) => void>(),
  onExit: vi.fn<(listener: (event: { exitCode: number; signal?: number }) => void) => void>(),
  verdictFromOutput: vi.fn<(output: string) => Promise<StepVerdict | null>>()
}))

vi.mock('node-pty', () => ({ spawn }))
vi.mock('child_process', () => ({ spawn: vi.fn() }))
vi.mock('./bin', () => ({
  resolveBinFrom: vi.fn(() => 'mock-ai'),
  aiEnv: vi.fn(() => ({}))
}))
vi.mock('./session', () => ({
  PtySession: class {
    whenReady = vi.fn().mockResolvedValue(true)
    interrupt = vi.fn()
    kill = vi.fn()
  },
  defaultShell: vi.fn(() => '/bin/sh'),
  pipelineEnv: vi.fn(() => ({}))
}))
vi.mock('./git-artifact', () => ({ runGitToArtifact: runGit, listGitFiles: listGit }))
vi.mock('./kill', () => ({ killPty: vi.fn(), killPidTree: vi.fn() }))
vi.mock('./jev', () => ({ verdictFromOutput }))
vi.mock('./remote', () => ({
  openRemote: vi.fn(),
  SignInRequired: class SignInRequired extends Error {},
  PaymentRequired: class PaymentRequired extends Error {}
}))
vi.mock('fs', () => ({
  default: {
    mkdirSync: vi.fn(),
    existsSync: vi.fn(() => false),
    writeFileSync: vi.fn()
  }
}))

import { PipelineRunner } from './runner'
import { PaymentRequired, SignInRequired } from './remote'

const pipeline: Pipeline = {
  id: 'review',
  name: 'Review',
  nodes: [
    {
      id: 'ai-review',
      name: 'AI review',
      type: 'ai',
      ai: 'claude',
      cmd: 'Review the changes',
      after: [],
      x: 0,
      y: 0
    }
  ]
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.clearAllMocks()
  spawn.mockReset().mockReturnValue({ onData, onExit })
  verdictFromOutput.mockReset().mockResolvedValue(null)
  listGit.mockReset().mockResolvedValue([])
})

afterEach(() => {
  vi.clearAllTimers()
  vi.useRealTimers()
})

function evaluation() {
  let resolve!: (verdict: StepVerdict | null) => void
  const promise = new Promise<StepVerdict | null>((done) => {
    resolve = done
  })
  verdictFromOutput.mockReturnValueOnce(promise)
  return { promise, resolve }
}

async function startRun(selected: Pipeline = pipeline) {
  const events: RunEvent[] = []
  const runner = new PipelineRunner((event) => events.push(event))
  const result = runner.run(selected, '/mock/project', 'main')
  await vi.waitFor(() => expect(onExit).toHaveBeenCalledTimes(1))
  expect(spawn).toHaveBeenCalledTimes(1)
  expect(onData).toHaveBeenCalledTimes(1)
  return {
    runner,
    events,
    result,
    data: onData.mock.calls[0][0],
    exit: onExit.mock.calls[0][0]
  }
}

describe('PipelineRunner async Jev verdict fallback', () => {
  it.each([
    { verdict: 'pass', exitCode: 7, code: 0, ok: true },
    { verdict: 'fail', exitCode: 0, code: 1, ok: false }
  ])('uses explicit FAROL_VERDICT $verdict without asking Jev', async ({ verdict, exitCode, code, ok }) => {
    const run = await startRun()
    const output = `Review complete\nFAROL_VERDICT: ${verdict}\n`
    run.data(output)
    run.exit({ exitCode })

    const result = await run.result
    expect(verdictFromOutput).not.toHaveBeenCalled()
    expect(result).toMatchObject({ ok, cancelled: undefined })
    expect(result.steps).toEqual([{ nodeId: 'ai-review', ok, code, output }])
    expect(run.events.filter((event) => event.kind === 'step-end')).toEqual([
      expect.objectContaining({ nodeId: 'ai-review', ok, code, cancelled: undefined })
    ])
    expect(run.events.filter((event) => event.kind === 'end')).toEqual([
      expect.objectContaining({ ok, cancelled: undefined })
    ])
  })

  it.each([
    { name: 'zero', exitCode: 0, signal: undefined, code: 0, ok: true },
    { name: 'nonzero', exitCode: 23, signal: undefined, code: 23, ok: false },
    { name: 'SIGABRT', exitCode: 0, signal: 6, code: 134, ok: false }
  ])('keeps the raw $name exit when Jev resolves null', async ({ exitCode, signal, code, ok }) => {
    const jev = evaluation()
    const run = await startRun()
    const output = 'Review complete without a verdict\n'
    run.data(output)
    run.exit({ exitCode, signal })

    expect(verdictFromOutput).toHaveBeenCalledExactlyOnceWith(output)
    await vi.advanceTimersByTimeAsync(0)
    expect(run.events.filter((event) => event.kind === 'step-end' || event.kind === 'end')).toEqual([])
    jev.resolve(null)

    const result = await run.result
    expect(result).toMatchObject({ ok, cancelled: undefined })
    expect(result.steps).toEqual([{ nodeId: 'ai-review', ok, code, output }])
    expect(run.events.filter((event) => event.kind === 'step-end')).toEqual([
      expect.objectContaining({ nodeId: 'ai-review', ok, code, cancelled: undefined })
    ])
    expect(run.events.filter((event) => event.kind === 'end')).toEqual([
      expect.objectContaining({ ok, cancelled: undefined })
    ])
  })

  it.each([
    { verdict: 'pass' as const, exitCode: 23, code: 0, ok: true },
    { verdict: 'fail' as const, exitCode: 0, code: 1, ok: false }
  ])('waits for Jev to resolve $verdict before settling the step', async ({ verdict, exitCode, code, ok }) => {
    const jev = evaluation()
    const run = await startRun()
    const output = 'Review complete without a verdict\n'
    run.data(output)
    run.exit({ exitCode })

    expect(verdictFromOutput).toHaveBeenCalledExactlyOnceWith(output)
    await vi.advanceTimersByTimeAsync(0)
    expect(run.events.filter((event) => event.kind === 'step-end' || event.kind === 'end')).toEqual([])
    jev.resolve(verdict)

    const result = await run.result
    expect(result).toMatchObject({ ok, cancelled: undefined })
    expect(result.steps).toEqual([{ nodeId: 'ai-review', ok, code, output }])
    expect(run.events.filter((event) => event.kind === 'step-end')).toEqual([
      expect.objectContaining({ nodeId: 'ai-review', ok, code, cancelled: undefined })
    ])
  })

  it.each<StepVerdict | null>(['pass', 'fail', null])(
    'stays cancelled when pending Jev later resolves %s',
    async (verdict) => {
      const jev = evaluation()
      const run = await startRun({
        ...pipeline,
        nodes: [
          ...pipeline.nodes,
          { ...pipeline.nodes[0], id: 'follow-up', after: ['ai-review'] }
        ]
      })
      const output = 'Review complete without a verdict\n'
      run.data(output)
      run.exit({ exitCode: 0 })

      expect(verdictFromOutput).toHaveBeenCalledExactlyOnceWith(output)
      await vi.advanceTimersByTimeAsync(0)
      expect(run.events.filter((event) => event.kind === 'step-end' || event.kind === 'end')).toEqual([])
      run.runner.cancel(pipeline.id)

      const result = await run.result
      expect(result).toMatchObject({ ok: false, cancelled: true, reportPath: undefined })
      expect(result.steps).toEqual([
        { nodeId: 'ai-review', ok: false, code: 130, output },
        { nodeId: 'follow-up', ok: false, code: 130, skipped: true, output: '' }
      ])
      expect(run.events.filter((event) => event.kind === 'step-end')).toEqual([
        expect.objectContaining({ nodeId: 'ai-review', ok: false, code: 130, cancelled: true }),
        expect.objectContaining({ nodeId: 'follow-up', ok: false, code: 130, cancelled: true })
      ])
      expect(run.events.filter((event) => event.kind === 'end')).toEqual([
        expect.objectContaining({ ok: false, cancelled: true })
      ])
      const settledEvents = structuredClone(run.events)
      const settledResult = structuredClone(result)

      jev.resolve(verdict)
      await jev.promise
      await Promise.resolve()

      expect(run.events).toEqual(settledEvents)
      expect(await run.result).toEqual(settledResult)
      expect(spawn).toHaveBeenCalledTimes(1)
      expect(verdictFromOutput).toHaveBeenCalledTimes(1)
    }
  )
})

describe('PipelineRunner remote target', () => {
  const remotePipeline: Pipeline = {
    id: 'remote',
    name: 'Remote',
    target: 'remote',
    nodes: [
      { id: 'lint', name: 'Lint', type: 'shell', cmd: 'npm run lint', after: [], x: 0, y: 0 },
      { id: 'test', name: 'Test', type: 'shell', cmd: 'npm test', after: ['lint'], x: 0, y: 0 }
    ]
  }

  function workspace(codes: Record<string, number> = {}) {
    return {
      summary: '2 files, 0.1 MB',
      exec: vi.fn(async (cmd: string, onChunk: (chunk: string) => void) => {
        onChunk(`ran ${cmd}\r\n`)
        return codes[cmd] ?? 0
      }),
      close: vi.fn().mockResolvedValue(undefined)
    }
  }

  it('runs shell steps in the sandbox and stops it afterwards', async () => {
    const remote = workspace()
    const events: RunEvent[] = []
    const runner = new PipelineRunner((event) => events.push(event), async () => remote)

    const result = await runner.run(remotePipeline, '/mock/project', 'main')

    expect(remote.exec.mock.calls.map(([cmd]) => cmd)).toEqual(['npm run lint', 'npm test'])
    expect(result.ok).toBe(true)
    expect(result.steps[1].output).toBe('ran npm test\r\n')
    expect(events).toContainEqual(
      expect.objectContaining({ kind: 'output', chunk: expect.stringContaining('2 files, 0.1 MB') })
    )
    expect(remote.close).toHaveBeenCalled()
    expect(spawn).not.toHaveBeenCalled()
  })

  it('runs git steps first, passes the result as a quoted ${as} and sends the file in the snapshot', async () => {
    runGit.mockResolvedValue({ preview: "it's a diff\n", truncated: false })
    const remote = workspace()
    const openRemote = vi.fn(async () => remote)
    const runner = new PipelineRunner(() => undefined, openRemote)
    const gitPipeline: Pipeline = {
      id: 'git',
      name: 'Git',
      target: 'remote',
      nodes: [
        { id: 'lint', name: 'Lint', type: 'shell', cmd: 'echo ${diff} ${diff_file}', after: ['d'], x: 0, y: 0 },
        { id: 'd', name: 'Diff', type: 'git', op: 'diff', base: 'main', paths: ['*.go'], as: 'diff', cmd: '', after: [], x: 0, y: 0 }
      ]
    }

    const result = await runner.run(gitPipeline, '/mock/project', 'main')

    expect(runGit).toHaveBeenCalledWith(
      '/mock/project',
      ['diff', '--no-color', '--no-ext-diff', '--no-textconv', '--no-renames', 'main', '--', '*.go'],
      '.farol/git/git/diff.patch',
      expect.any(AbortSignal)
    )
    expect(openRemote).toHaveBeenCalledWith('/mock/project', expect.any(AbortSignal), ['.farol/git/git/diff.patch'])
    expect(remote.exec.mock.calls.map(([cmd]) => cmd)).toEqual([`echo 'it'\\''s a diff' '.farol/git/git/diff.patch'`])
    expect(result.ok).toBe(true)
  })

  it('fails a step whose own text is over the command limit, without running it', async () => {
    const remote = workspace()
    const runner = new PipelineRunner(() => undefined, vi.fn(async () => remote))
    const pipeline: Pipeline = {
      id: 'big',
      name: 'Big',
      target: 'remote',
      nodes: [{ id: 'a', name: 'A', type: 'shell', cmd: 'x'.repeat(130_000), after: [], x: 0, y: 0 }]
    }

    const result = await runner.run(pipeline, '/mock/project', 'main')

    expect(result.ok).toBe(false)
    expect(remote.exec).not.toHaveBeenCalled()
  })

  it.each([
    ['output longer than the preview', 'x'.repeat(100_000), true],
    ['quotes, which grow when quoted', "'".repeat(30_000), false],
    ['multibyte text', '€'.repeat(40_000), false]
  ])('keeps a command with a long git result (%s) used twice within the limit', async (_, preview, truncated) => {
    runGit.mockResolvedValue({ preview, truncated })
    const remote = workspace()
    const runner = new PipelineRunner(() => undefined, async () => remote)
    await runner.run(
      {
        ...remotePipeline,
        nodes: [
          { id: 'd', name: 'Diff', type: 'git', op: 'diff', as: 'diff', cmd: '', after: [], x: 0, y: 0 },
          { id: 's', name: 'Show', type: 'shell', cmd: 'echo ${diff} ${diff}', after: ['d'], x: 0, y: 0 }
        ]
      },
      '/mock/project',
      'main'
    )
    const [cmd] = remote.exec.mock.calls[0]
    expect(Buffer.byteLength(quoteShellArg(cmd))).toBeLessThanOrEqual(120_000)
    expect(cmd).toContain('[cut')
  })

  it('leaves likely-secret files out of a remote diff', async () => {
    listGit.mockResolvedValue(['src/a.go', '.env', 'keys/id_rsa'])
    runGit.mockResolvedValue({ preview: 'diff', truncated: false })
    const runner = new PipelineRunner(() => undefined, async () => workspace())
    await runner.run(
      {
        ...remotePipeline,
        nodes: [{ id: 'd', name: 'Diff', type: 'git', op: 'diff', base: 'main', cmd: '', after: [], x: 0, y: 0 }]
      },
      '/mock/project',
      'main'
    )
    expect(listGit).toHaveBeenCalledWith(
      '/mock/project',
      ['diff', '--no-color', '--no-ext-diff', '--no-textconv', '--no-renames', '--name-only', '-z', 'main', '--'],
      expect.any(AbortSignal)
    )
    expect(runGit.mock.calls[0][1]).toEqual([
      'diff', '--no-color', '--no-ext-diff', '--no-textconv', '--no-renames', 'main', '--', ':(top,exclude,literal).env', ':(top,exclude,literal)keys/id_rsa'
    ])
  })

  it('refuses a remote git step that waits on a shell step', async () => {
    const runner = new PipelineRunner(() => undefined, async () => workspace())
    const result = await runner.run(
      {
        ...remotePipeline,
        nodes: [
          remotePipeline.nodes[0],
          { id: 'd', name: 'Diff', type: 'git', op: 'diff', cmd: '', after: ['lint'], x: 0, y: 0 }
        ]
      },
      '/mock/project',
      'main'
    )
    expect(result.ok).toBe(false)
    expect(result.steps[0].output).toContain('cannot run after a shell or AI step')
  })

  it('fails the step and skips its descendants on a non-zero remote exit', async () => {
    const remote = workspace({ 'npm run lint': 2 })
    const runner = new PipelineRunner(() => undefined, async () => remote)

    const result = await runner.run(remotePipeline, '/mock/project', 'main')

    expect(result).toMatchObject({ ok: false, failedNodeId: 'lint' })
    expect(remote.exec).toHaveBeenCalledTimes(1)
    expect(remote.close).toHaveBeenCalled()
  })

  it('ends the run with the reason when the sandbox cannot start', async () => {
    const events: RunEvent[] = []
    const runner = new PipelineRunner(
      (event) => events.push(event),
      async () => {
        throw new Error('Remote service is not configured.')
      }
    )

    const result = await runner.run(remotePipeline, '/mock/project', 'main')

    expect(result).toMatchObject({ ok: false, cancelled: undefined })
    expect(events).toContainEqual(
      expect.objectContaining({ kind: 'output', chunk: expect.stringContaining('Remote service is not configured.') })
    )
    expect(events.at(-1)).toMatchObject({ kind: 'end', ok: false })
  })

  it('asks to sign in, without retrying, when there is no session', async () => {
    const events: RunEvent[] = []
    const open = vi.fn().mockRejectedValue(new SignInRequired())
    const runner = new PipelineRunner((event) => events.push(event), open)

    const result = await runner.run(remotePipeline, '/mock/project', 'main')

    expect(open).toHaveBeenCalledTimes(1)
    expect(result.ok).toBe(false)
    const output = events.flatMap((e) => (e.kind === 'output' ? [e.chunk] : [])).join('')
    expect(output).toContain('Sign in to run remote pipelines.')
    expect(output).not.toMatch(/https?:|attempt/)
  })

  it('shows the 402 message, without retrying or links', async () => {
    const events: RunEvent[] = []
    const open = vi.fn().mockRejectedValue(new PaymentRequired('Free sandboxes used up.'))
    const runner = new PipelineRunner((event) => events.push(event), open)

    const result = await runner.run(remotePipeline, '/mock/project', 'main')

    expect(open).toHaveBeenCalledTimes(1)
    expect(result.ok).toBe(false)
    const output = events.flatMap((e) => (e.kind === 'output' ? [e.chunk] : [])).join('')
    expect(output).toContain('Free sandboxes used up.')
    expect(output).not.toMatch(/https?:|attempt/)
  })

  it('retries the sandbox start up to three times, then fails', async () => {
    const open = vi.fn().mockRejectedValue(new Error('boot failed'))
    const runner = new PipelineRunner(() => undefined, open)

    const result = await runner.run(remotePipeline, '/mock/project', 'main')

    expect(open).toHaveBeenCalledTimes(3)
    expect(result.ok).toBe(false)
    expect(spawn).not.toHaveBeenCalled()
  })

  it('succeeds when a retry brings the sandbox up', async () => {
    const remote = workspace()
    const open = vi.fn().mockRejectedValueOnce(new Error('flaky')).mockResolvedValue(remote)
    const runner = new PipelineRunner(() => undefined, open)

    const result = await runner.run(remotePipeline, '/mock/project', 'main')

    expect(open).toHaveBeenCalledTimes(2)
    expect(result.ok).toBe(true)
  })

  it('runs on this machine after three failed starts when fallbackLocal is set', async () => {
    const open = vi.fn().mockRejectedValue(new Error('boot failed'))
    const events: RunEvent[] = []
    const runner = new PipelineRunner((event) => events.push(event), open)

    await runner.run({ ...remotePipeline, fallbackLocal: true }, '/mock/project', 'main')

    expect(open).toHaveBeenCalledTimes(3)
    expect(events).toContainEqual(
      expect.objectContaining({ kind: 'output', chunk: expect.stringContaining('falling back to this machine') })
    )
    expect(spawn).toHaveBeenCalled()
  })
})
