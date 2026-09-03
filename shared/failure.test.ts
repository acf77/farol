import { describe, expect, it } from 'vitest'
import { REPORT_OUTPUT_LIMIT, failureReport, gitignoreWithEntry } from './failure'
import { aiFixCommand, aiFixPrompt } from './ai'
import { sanitizeSettings } from './settings'

const base = {
  pipeline: 'Lint & Typecheck',
  step: 'ESLint',
  branch: 'ci/lint',
  cwd: '/Users/acf/dev/app-ci-lint',
  cmd: 'npx eslint . --max-warnings 0',
  code: 1,
  output: 'src/App.tsx:12:5  error  Unexpected any'
}

describe('failureReport', () => {
  it('names the step, branch, and command an agent needs', () => {
    const md = failureReport(base)
    expect(md).toContain('- Step: ESLint')
    expect(md).toContain('- Branch: ci/lint')
    expect(md).toContain('- Exit code: 1')
    expect(md).toContain('npx eslint . --max-warnings 0')
    expect(md).toContain('Unexpected any')
  })

  it('keeps the tail of long output, where the errors are', () => {
    const output = 'x'.repeat(REPORT_OUTPUT_LIMIT) + 'THE-ACTUAL-ERROR'
    const md = failureReport({ ...base, output })
    expect(md).toContain('THE-ACTUAL-ERROR')
    // Output is capped; the rest is fixed-size headers and the verify section.
    expect(md.length).toBeLessThan(REPORT_OUTPUT_LIMIT + 1500)
  })

  it('says so rather than leaving an empty block', () => {
    expect(failureReport({ ...base, output: '   \n  ' })).toContain('(no output)')
  })

  it('says where the run happened, so a fix lands in the right worktree', () => {
    const md = failureReport(base)
    expect(md).toContain('- Working directory: /Users/acf/dev/app-ci-lint')
    expect(md).toContain('Confirm you are in that directory and on that branch')
  })

  it('names the failing step in the instructions, not just the header', () => {
    const md = failureReport(base)
    expect(md).toContain('The `ESLint` step ran this command')
    expect(md).toContain('fixing the `ESLint` step')
  })

  it('explains a signal exit code instead of leaving 134 bare', () => {
    // After the OOM fix a crashed step reports 134; without this note an agent
    // hunts for lint errors the process never got round to printing.
    const md = failureReport({ ...base, code: 134 })
    expect(md).toContain('SIGABRT')
    expect(md).toContain('ran out of heap memory')
    expect(md).toContain('crashed rather than reporting failures')
  })

  it('leaves an ordinary failure code unannotated', () => {
    expect(failureReport({ ...base, code: 1 })).toContain('- Exit code: 1\n')
    expect(failureReport({ ...base, code: 1 })).not.toContain('killed by')
  })

  it('tells the agent how to verify, naming the pipeline to re-run', () => {
    const md = failureReport({ ...base, pipelineId: 'repo-abc:managed-pipeline:lint' })
    expect(md).toContain('run_pipeline')
    expect(md).toContain('list_pipelines')
    // Prefer the real catalog id so agents do not invent a literal "id".
    expect(md).toContain('FAROL_PIPELINES: ["repo-abc:managed-pipeline:lint"]')
    expect(md).not.toContain('FAROL_PIPELINES: ["id"]')
    // Without the name the agent has to guess which of several pipelines to run.
    expect(md).toMatch(/run_pipeline` with pipeline `Lint & Typecheck`/)
    expect(md).toContain('name or bare id from `list_pipelines`')
  })

  it('maps a UI runner slot to the managed Chat catalog id', () => {
    const md = failureReport({ ...base, pipelineId: 'repo-abc:pipeline:lint' })
    expect(md).toContain('FAROL_PIPELINES: ["repo-abc:managed-pipeline:lint"]')
    expect(md).not.toContain('FAROL_PIPELINES: ["repo-abc:pipeline:lint"]')
  })

  it('maps an MCP runner slot to the managed Chat catalog id', () => {
    const md = failureReport({ ...base, pipelineId: 'repo-abc:mcp-pipeline:lint' })
    expect(md).toContain('FAROL_PIPELINES: ["repo-abc:managed-pipeline:lint"]')
    expect(md).not.toContain('FAROL_PIPELINES: ["repo-abc:mcp-pipeline:lint"]')
  })

  it('uses a catalog placeholder when the pipeline id is unknown', () => {
    const md = failureReport(base)
    expect(md).toContain('FAROL_PIPELINES: ["<pipeline-id-from-catalog>"]')
    expect(md).not.toContain('FAROL_PIPELINES: ["id"]')
  })

  it('omits bare or unrecognized ids rather than pasting an invalid marker', () => {
    expect(failureReport({ ...base, pipelineId: 'lint' })).toContain(
      'FAROL_PIPELINES: ["<pipeline-id-from-catalog>"]'
    )
    expect(failureReport({ ...base, pipelineId: 'lint' })).not.toContain(
      'FAROL_PIPELINES: ["lint"]'
    )
  })

  it('prefers Farol but keeps a last-resort direct command when MCP is absent', () => {
    const md = failureReport(base)
    expect(md).toContain('Do not re-run the failing command yourself when Farol is available')
    expect(md).toContain('If neither managed Chat nor that MCP tool is available')
    expect(md).not.toContain('iterate quickly')
    expect(md.indexOf('## Output')).toBeLessThan(md.indexOf('## Verify your fix'))
  })

  it('keeps the verify section out of the truncated output block', () => {
    const md = failureReport({ ...base, output: 'x'.repeat(REPORT_OUTPUT_LIMIT * 2) })
    expect(md).toContain('## Verify your fix')
  })
})

describe('gitignoreWithEntry', () => {
  it('creates the file when there is none', () => {
    expect(gitignoreWithEntry('', 'last-failure.md')).toBe('last-failure.md\n')
  })

  it('leaves pipelines.json committable by ignoring only the report', () => {
    expect(gitignoreWithEntry('', 'last-failure.md')).not.toContain('*')
  })

  it('appends without eating the previous line', () => {
    expect(gitignoreWithEntry('other\n', 'last-failure.md')).toBe('other\nlast-failure.md\n')
    expect(gitignoreWithEntry('other', 'last-failure.md')).toBe('other\nlast-failure.md\n')
  })

  it('is a no-op once the entry is there', () => {
    expect(gitignoreWithEntry('last-failure.md\n', 'last-failure.md')).toBeNull()
    expect(gitignoreWithEntry('a\n  last-failure.md  \nb\n', 'last-failure.md')).toBeNull()
  })
})

describe('aiFixPrompt', () => {
  it('points at the report a failed run left', () => {
    expect(aiFixPrompt()).toContain('.farol/last-failure.md')
    expect(aiFixPrompt()).toMatch(/just failed/)
    expect(aiFixPrompt()).toContain('Verify section')
    expect(aiFixPrompt()).toMatch(/do not invent a literal id/i)
  })
})

describe('aiFixCommand', () => {
  it('uses each CLI interactive form, pointing at the report', () => {
    expect(aiFixCommand('claude')).toMatch(/^claude "Read \.farol\/last-failure\.md/)
    expect(aiFixCommand('cursor')).toMatch(/^cursor-agent "/)
    expect(aiFixCommand('codex')).toMatch(/^codex "/)
    expect(aiFixCommand('opencode')).toMatch(/^opencode run "/)
  })

  it('produces nothing a shell would have to escape', () => {
    for (const p of ['claude', 'cursor', 'codex', 'opencode'] as const) {
      const cmd = aiFixCommand(p)
      expect(cmd.split('"').length - 1).toBe(2)
      expect(cmd).not.toMatch(/[\n`$\\]/)
    }
  })
})

describe('sanitizeSettings', () => {
  it('falls back to Claude on junk', () => {
    expect(sanitizeSettings(undefined)).toEqual({ agent: 'claude', autoFix: true })
    expect(sanitizeSettings({ agent: 'gpt-9', autoFix: 'yes' })).toEqual({
      agent: 'claude',
      autoFix: true
    })
  })

  it('keeps a real choice', () => {
    expect(sanitizeSettings({ agent: 'codex', autoFix: false })).toEqual({
      agent: 'codex',
      autoFix: false
    })
  })

  it('keeps OpenRouter pins and catalog, never a hasKey flag', () => {
    expect(
      sanitizeSettings({
        agent: 'openrouter',
        autoFix: true,
        openrouter: {
          hasKey: true,
          autoPinned: true,
          pinned: ['openai/gpt-4o', 'openai/gpt-4o'],
          catalog: [{ id: 'openai/gpt-4o', label: 'GPT-4o' }]
        }
      })
    ).toEqual({
      agent: 'openrouter',
      autoFix: true,
      openrouter: {
        autoPinned: true,
        pinned: ['openai/gpt-4o'],
        catalog: [{ id: 'openai/gpt-4o', label: 'GPT-4o' }]
      }
    })
  })

  it('keeps a chosen model so a new chat can reuse it', () => {
    expect(sanitizeSettings({ agent: 'claude', autoFix: true, model: 'opus' })).toEqual({
      agent: 'claude',
      model: 'opus',
      autoFix: true
    })
  })

  it('drops a blank model so the CLI default applies', () => {
    expect(sanitizeSettings({ agent: 'cursor', autoFix: true, model: '  ' })).toEqual({
      agent: 'cursor',
      autoFix: true
    })
  })
})
