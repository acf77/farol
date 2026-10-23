import { describe, expect, it } from 'vitest'
import {
  claudeMcpConfig,
  managedMcpEntry,
  mergeMcpConfig,
  MCP_CONFIG_REL_PATHS,
  servesPipelineTools
} from './mcp-config'
import { socketPathFor, takeLines } from './bridge'
import { resolvePipeline } from './graph'
import type { Pipeline } from './types'

const entry = { command: '/Applications/Farol.app/Contents/MacOS/Farol', args: ['/x/mcp.js'] }

describe('mergeMcpConfig', () => {
  it('creates the file when the project has none', () => {
    const out = mergeMcpConfig('', entry)
    expect(JSON.parse(out!)).toEqual({ mcpServers: { farol: entry } })
  })

  it('targets Claude and Cursor project paths', () => {
    expect([...MCP_CONFIG_REL_PATHS]).toEqual(['.mcp.json', '.cursor/mcp.json'])
  })

  it('merges into a Cursor user config that already has URL servers', () => {
    const existing = JSON.stringify({
      mcpServers: { posthog: { url: 'https://mcp.posthog.com/mcp' } }
    })
    const parsed = JSON.parse(mergeMcpConfig(existing, entry)!)
    expect(parsed.mcpServers.posthog).toEqual({ url: 'https://mcp.posthog.com/mcp' })
    expect(parsed.mcpServers.farol).toEqual(entry)
  })

  it('leaves other servers alone', () => {
    const existing = JSON.stringify({ mcpServers: { github: { command: 'gh-mcp', args: [] } } })
    const parsed = JSON.parse(mergeMcpConfig(existing, entry)!)
    expect(parsed.mcpServers.github).toEqual({ command: 'gh-mcp', args: [] })
    expect(parsed.mcpServers.farol).toEqual(entry)
  })

  it('keeps unrelated top-level keys', () => {
    const parsed = JSON.parse(mergeMcpConfig(JSON.stringify({ other: 1 }), entry)!)
    expect(parsed.other).toBe(1)
  })

  it('does not rewrite a file that already matches', () => {
    const current = mergeMcpConfig('', entry)!
    expect(mergeMcpConfig(current, entry)).toBeNull()
  })

  it('updates a stale entry when the app moves', () => {
    const current = mergeMcpConfig('', { ...entry, args: ['/old/mcp.js'] })!
    expect(mergeMcpConfig(current, entry)).not.toBeNull()
  })

  it('drops a leftover buildflow key even when farol already matches', () => {
    const existing = JSON.stringify({
      mcpServers: {
        farol: entry,
        buildflow: { command: '/Applications/BuildFlow.app/Contents/MacOS/BuildFlow', args: ['/x/mcp.js'] },
        github: { command: 'gh-mcp', args: [] }
      }
    })
    const out = mergeMcpConfig(existing, entry)
    expect(out).not.toBeNull()
    const parsed = JSON.parse(out!)
    expect(parsed.mcpServers.farol).toEqual(entry)
    expect(parsed.mcpServers.github).toEqual({ command: 'gh-mcp', args: [] })
    expect(parsed.mcpServers.buildflow).toBeUndefined()
  })

  it('refuses to touch a file it cannot parse', () => {
    expect(mergeMcpConfig('{ not json', entry)).toBeNull()
    expect(mergeMcpConfig('[1,2]', entry)).toBeNull()
  })
})

const pipelines = [
  { id: 'lint', name: 'Lint & Typecheck', nodes: [] },
  { id: 'full', name: 'Full Check', nodes: [] },
  { id: 'pl123', name: 'Ship to GitHub', nodes: [] }
] as unknown as Pipeline[]

const ok = (q: string): string => {
  const r = resolvePipeline(pipelines, q)
  return r.ok ? r.pipeline.id : `ERR:${r.message}`
}

describe('resolvePipeline', () => {
  it('takes an id', () => expect(ok('lint')).toBe('lint'))

  it('takes a name, case-insensitively', () => {
    expect(ok('Lint & Typecheck')).toBe('lint')
    expect(ok('full check')).toBe('full')
  })

  it('takes an unambiguous partial, which is how agents actually ask', () => {
    expect(ok('Ship')).toBe('pl123')
    expect(ok('github')).toBe('pl123')
  })

  it('refuses to guess between candidates', () => {
    const r = resolvePipeline(pipelines, 'ch')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.candidates.length).toBeGreaterThan(1)
  })

  it('lists what exists when nothing matches', () => {
    const r = resolvePipeline(pipelines, 'deploy')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.candidates).toHaveLength(3)
  })

  it('prefers an exact id over a partial name match', () => {
    const clash = [
      { id: 'lint', name: 'Something else', nodes: [] },
      { id: 'x', name: 'lint the thing', nodes: [] }
    ] as unknown as Pipeline[]
    const r = resolvePipeline(clash, 'lint')
    expect(r.ok && r.pipeline.id).toBe('lint')
  })
})

describe('socket path', () => {
  it('is stable for a project, so .mcp.json does not churn on restart', () => {
    expect(socketPathFor('/repos/app', '/tmp')).toBe(socketPathFor('/repos/app', '/tmp'))
  })

  it('differs per project, so two windows do not collide', () => {
    expect(socketPathFor('/repos/app', '/tmp')).not.toBe(socketPathFor('/repos/other', '/tmp'))
  })

  it('produces one path segment with no separators from the project', () => {
    const p = socketPathFor('/a/b/c', '/tmp')
    expect(p.startsWith('/tmp/farol-')).toBe(true)
    expect(p.slice('/tmp/'.length)).not.toContain('/')
  })
})

describe('takeLines', () => {
  it('holds back a partial frame until its newline arrives', () => {
    const first = takeLines('{"a":1}\n{"b":2')
    expect(first.lines).toEqual(['{"a":1}'])
    expect(takeLines(first.rest + '}\n').lines).toEqual(['{"b":2}'])
  })

  it('ignores blank frames', () => {
    expect(takeLines('\n\n{"a":1}\n').lines).toEqual(['{"a":1}'])
  })
})

describe('managed MCP server', () => {
  const script = { command: '/app/Farol', args: ['/app/mcp.js'], env: { ELECTRON_RUN_AS_NODE: '1' } }

  it('marks the entry as managed and names its task', () => {
    expect(managedMcpEntry(script, 't1')).toEqual({
      ...script,
      env: { ELECTRON_RUN_AS_NODE: '1', FAROL_MANAGED: '1', FAROL_TASK_ID: 't1' }
    })
    expect(script.env).toEqual({ ELECTRON_RUN_AS_NODE: '1' })
  })

  it('uses its own key so the project farol entry cannot shadow it', () => {
    expect(Object.keys(JSON.parse(claudeMcpConfig(script)).mcpServers)).toEqual(['farol-chat'])
  })

  it('offers pipeline tools only outside managed Chat', () => {
    expect(servesPipelineTools({})).toBe(true)
    expect(servesPipelineTools({ FAROL_MANAGED: '1' })).toBe(false)
  })
})
