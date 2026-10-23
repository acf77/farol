import { describe, expect, it } from 'vitest'
import {
  acpApprovalAsk,
  acpExitCode,
  acpMcpServer,
  acpModeValue,
  acpPermissionChoice,
  acpToolDetail,
  acpToolName,
  acpToolState
} from './acp'

const modes = (...values: string[]) => [{ id: 'mode', options: values.map((value) => ({ value })) }]

describe('acp mapping', () => {
  it('passes the managed server with its env as name/value pairs', () => {
    expect(acpMcpServer('farol-chat', { command: '/app', args: ['/mcp.js'], env: { A: '1' } })).toEqual({
      name: 'farol-chat',
      command: '/app',
      args: ['/mcp.js'],
      env: [{ name: 'A', value: '1' }]
    })
  })

  it('maps Plan only to a plan mode, and Build to build or default', () => {
    expect(acpModeValue('plan', modes('build', 'plan'))).toBe('plan')
    expect(acpModeValue('plan', modes('build'))).toBeUndefined()
    expect(acpModeValue('build', modes('build', 'plan'))).toBe('build')
    expect(acpModeValue('build', modes('default', 'plan'))).toBe('default')
    expect(acpModeValue('build', undefined)).toBeUndefined()
  })

  it('names tools by kind, and MCP tools by title', () => {
    expect(acpToolName({ kind: 'execute', title: 'echo hi' })).toBe('bash')
    expect(acpToolName({ kind: 'edit', title: 'a.ts' })).toBe('edit')
    expect(acpToolName({ kind: 'other', title: 'farol-chat_delegate' })).toBe('farol-chat_delegate')
    expect(acpToolName({ status: 'completed' }, 'bash')).toBe('bash')
  })

  it('details a call by its command or path, never a shell call’s working directory', () => {
    expect(acpToolDetail({ kind: 'execute', rawInput: { command: 'npm test' } })).toBe('npm test')
    expect(acpToolDetail({ kind: 'edit', rawInput: { filePath: '/r/a.ts' } })).toBe('/r/a.ts')
    expect(acpToolDetail({ kind: 'execute', title: 'bash', locations: [{ path: '/r' }], rawInput: { cwd: '/r' } })).toBeUndefined()
    expect(acpToolDetail({ kind: 'read', locations: [{ path: '/r/b.ts' }] })).toBe('/r/b.ts')
  })

  it('maps statuses', () => {
    expect(acpToolState('pending')).toBe('running')
    expect(acpToolState('in_progress')).toBe('running')
    expect(acpToolState('completed')).toBe('done')
    expect(acpToolState('failed')).toBe('error')
    expect(acpToolState(undefined)).toBeUndefined()
  })

  it('asks about a call by its tool and input', () => {
    expect(acpApprovalAsk({ kind: 'execute', title: 'echo hi', rawInput: { command: 'echo hi' } })).toEqual({
      toolName: 'bash',
      input: { command: 'echo hi' }
    })
    expect(acpApprovalAsk({ kind: 'edit', title: 'src/a.ts' })).toEqual({ toolName: 'edit', input: { command: 'src/a.ts' } })
  })

  it('answers once either way, never "always", and cancels when nothing fits', () => {
    const options = [
      { optionId: 'once', kind: 'allow_once' },
      { optionId: 'always', kind: 'allow_always' },
      { optionId: 'reject', kind: 'reject_once' }
    ]
    expect(acpPermissionChoice(options, true)).toBe('once')
    expect(acpPermissionChoice(options, false)).toBe('reject')
    expect(acpPermissionChoice([{ optionId: 'a', kind: 'allow_always' }], true)).toBe('a')
    expect(acpPermissionChoice([{ optionId: 'a', kind: 'allow_once' }], false)).toBeUndefined()
  })

  it('treats only a finished turn as success', () => {
    expect(acpExitCode('end_turn')).toBe(0)
    expect(acpExitCode('max_tokens')).toBe(0)
    expect(acpExitCode('cancelled')).toBe(1)
    expect(acpExitCode('refusal')).toBe(1)
  })
})
