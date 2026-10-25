import { execFileSync } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentTaskEvent, AgentTaskRequest, PipelineRunResult } from '../shared/types'

vi.mock('./jev', () => ({
  selectPipelines: vi.fn().mockResolvedValue(null),
  selectTools: vi.fn().mockResolvedValue(null)
}))
vi.mock('./backoff', () => ({ backoffDelayMs: () => 0, backoffWait: () => Promise.resolve() }))

import { AgentController, type AgentExecutor } from './agent-controller'

let repo: string

beforeEach(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'farol-turn-tree-'))
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repo })
  git('init', '-q')
  git('config', 'user.email', 't@example.com')
  git('config', 'user.name', 'T')
  fs.writeFileSync(path.join(repo, 'app.ts'), 'export const name = "Widget"\n')
  fs.writeFileSync(path.join(repo, '.gitignore'), '.env\n')
  git('add', '.')
  git('commit', '-qm', 'init')
})

afterEach(() => fs.rmSync(repo, { recursive: true, force: true }))

const lint = {
  id: 'lint',
  name: 'Lint',
  mandatory: true,
  nodes: [{ id: 'lint-step', name: 'Lint', type: 'shell' as const, cmd: 'npm run lint', after: [], x: 0, y: 0 }]
}

function request(): AgentTaskRequest {
  return {
    id: 'task-1',
    prompt: 'Rename the widget',
    provider: 'claude',
    mode: 'build',
    pipelines: [lint],
    cwd: repo,
    checkout: repo,
    branch: 'main',
    maxAttempts: 3
  }
}

const passed: PipelineRunResult = { runId: 'r', pipelineId: 'lint', ok: true, steps: [{ nodeId: 'lint-step', ok: true, code: 0, output: '' }] }

/**
 * An agent that runs `cmd` through its shell tool (`change` does what the command would) and opts
 * out of validation with `[]`; asked again, it selects the mandatory pipeline.
 */
function shellTurn(cmd: string, change?: () => void): AgentExecutor {
  return vi
    .fn<AgentExecutor>()
    .mockImplementationOnce(async (_request, _prompt, output, onTool) => {
      change?.()
      onTool?.({ toolId: 'sh-1', name: 'Bash', detail: cmd, state: 'done' })
      output('Done.\nFAROL_PIPELINES: []\n')
      return 0
    })
    .mockImplementation(async (_request, _prompt, output) => {
      output('FAROL_PIPELINES: ["lint"]\n')
      return 0
    })
}

async function runTurn(execute: AgentExecutor): Promise<{ ran: string[]; status: string }> {
  const events: AgentTaskEvent[] = []
  const run = vi.fn().mockResolvedValue(passed)
  const controller = new AgentController({ run }, (event) => events.push(event), execute)
  controller.start(request())
  await vi.waitFor(() => expect(events.some((e) => e.kind === 'status' && e.status === 'completed')).toBe(true), { timeout: 10_000 })
  const done = events.find((e) => e.kind === 'status' && e.status === 'completed')
  return { ran: run.mock.calls.map((call) => call[0].id), status: (done && 'message' in done && done.message) || '' }
}

describe('a turn that changes files through the shell', () => {
  it.each([
    ['sed -i', "sed -i 's/Widget/Gadget/' app.ts", () => fs.writeFileSync(path.join(repo, 'app.ts'), 'export const name = "Gadget"\n')],
    ['a formatter', 'npx prettier --write .', () => fs.writeFileSync(path.join(repo, 'app.ts'), "export const name = 'Widget'\n")],
    ['a heredoc', "cat > new.ts <<'EOF'", () => fs.writeFileSync(path.join(repo, 'new.ts'), 'export const x = 1\n')]
  ])('refuses [] and runs mandatory pipelines when it changes files with %s', async (_, cmd, change) => {
    const execute = shellTurn(cmd, change)
    const { ran, status } = await runTurn(execute)
    expect(vi.mocked(execute).mock.calls[1][1]).toContain('skipped mandatory pipelines')
    expect(ran).toEqual(['lint'])
    expect(status).toContain('Lint passed')
  })

  it('needs no validation when the shell only read the project', async () => {
    const execute = shellTurn('git status --short')
    const { ran, status } = await runTurn(execute)
    expect(execute).toHaveBeenCalledTimes(1)
    expect(ran).toEqual([])
    expect(status).toContain('No validation needed')
  })

  it('needs no validation when only an ignored file changed', async () => {
    const { ran } = await runTurn(shellTurn('echo SECRET=1 > .env', () => fs.writeFileSync(path.join(repo, '.env'), 'SECRET=1\n')))
    expect(ran).toEqual([])
  })
})
