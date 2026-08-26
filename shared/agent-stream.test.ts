import { describe, expect, it } from 'vitest'
import { AgentStreamParser, toolDetail } from './agent-stream'

/** Shapes below are trimmed copies of real `--output-format stream-json` output. */
const claudeToolUse = JSON.stringify({
  type: 'assistant',
  message: {
    role: 'assistant',
    content: [{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'cat a.txt' } }]
  }
})
const claudeToolResult = JSON.stringify({
  type: 'user',
  message: {
    role: 'user',
    content: [{ tool_use_id: 'toolu_1', type: 'tool_result', content: 'hello', is_error: false }]
  }
})
const claudeText = JSON.stringify({
  type: 'assistant',
  message: { role: 'assistant', content: [{ type: 'text', text: 'Contains just: "hello".' }] }
})

function parse(parser: AgentStreamParser, ...chunks: string[]) {
  return chunks.flatMap((chunk) => parser.push(chunk))
}

describe('AgentStreamParser', () => {
  it('reports a tool call as it starts and again when it finishes', () => {
    const parser = new AgentStreamParser()
    const events = parse(parser, `${claudeToolUse}\n${claudeToolResult}\n`)
    expect(events).toEqual([
      { kind: 'tool', toolId: 'toolu_1', name: 'Bash', detail: 'cat a.txt', state: 'running' },
      { kind: 'tool', toolId: 'toolu_1', name: 'Bash', state: 'done' }
    ])
  })

  it('marks a failed tool result as an error', () => {
    const parser = new AgentStreamParser()
    const failed = JSON.stringify({
      type: 'user',
      message: { role: 'user', content: [{ tool_use_id: 'toolu_1', type: 'tool_result', is_error: true }] }
    })
    parse(parser, `${claudeToolUse}\n`)
    expect(parse(parser, `${failed}\n`)).toEqual([
      { kind: 'tool', toolId: 'toolu_1', name: 'Bash', state: 'error' }
    ])
  })

  it('emits assistant prose as one turn and ignores session chrome', () => {
    const parser = new AgentStreamParser()
    const noise = [
      JSON.stringify({ type: 'system', subtype: 'init', tools: ['Bash'] }),
      JSON.stringify({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed' } }),
      JSON.stringify({ type: 'result', subtype: 'success', result: 'Contains just: "hello".' })
    ].join('\n')
    expect(parse(parser, `${noise}\n`)).toEqual([])
    expect(parse(parser, `${claudeText}\n`)).toEqual([
      { kind: 'text', text: 'Contains just: "hello".' }
    ])
  })

  it('holds back a line split across chunks', () => {
    const parser = new AgentStreamParser()
    const half = Math.floor(claudeText.length / 2)
    expect(parse(parser, claudeText.slice(0, half))).toEqual([])
    expect(parse(parser, `${claudeText.slice(half)}\n`)).toEqual([
      { kind: 'text', text: 'Contains just: "hello".' }
    ])
  })

  it('flushes a final line that never got its newline', () => {
    const parser = new AgentStreamParser()
    expect(parse(parser, claudeText)).toEqual([])
    expect(parser.flush()).toEqual([{ kind: 'text', text: 'Contains just: "hello".' }])
  })

  it('passes non-JSON lines through instead of swallowing them', () => {
    const parser = new AgentStreamParser()
    expect(parse(parser, 'warning: node 18 is deprecated\n')).toEqual([
      { kind: 'raw', text: 'warning: node 18 is deprecated\n' }
    ])
    expect(parse(parser, '{"type":"assistant",BROKEN\n')).toEqual([
      { kind: 'raw', text: '{"type":"assistant",BROKEN\n' }
    ])
  })

  it('reads Cursor tool_call events, whose id spans a newline', () => {
    const parser = new AgentStreamParser()
    const started = JSON.stringify({
      type: 'tool_call',
      subtype: 'started',
      call_id: 'call-7b6\nfc_b13',
      tool_call: { shellToolCall: { args: { command: 'cat a.txt', workingDirectory: '' } } }
    })
    const completed = JSON.stringify({
      type: 'tool_call',
      subtype: 'completed',
      call_id: 'call-7b6\nfc_b13',
      tool_call: { shellToolCall: { args: { command: 'cat a.txt' } } }
    })
    // JSON.stringify escapes the newline, so both arrive on one line each.
    expect(parse(parser, `${started}\n${completed}\n`)).toEqual([
      { kind: 'tool', toolId: 'call-7b6 fc_b13', name: 'shell', detail: 'cat a.txt', state: 'running' },
      { kind: 'tool', toolId: 'call-7b6 fc_b13', name: 'shell', detail: 'cat a.txt', state: 'done' }
    ])
  })

  it('ignores an unknown event type rather than showing its JSON', () => {
    const parser = new AgentStreamParser()
    expect(parse(parser, `${JSON.stringify({ type: 'something_new', data: 1 })}\n`)).toEqual([])
  })
})

describe('toolDetail', () => {
  it('prefers the field that identifies the call', () => {
    expect(toolDetail({ description: 'Read it', command: 'cat a.txt' })).toBe('cat a.txt')
    expect(toolDetail({ file_path: '/tmp/a.ts' })).toBe('/tmp/a.ts')
    expect(toolDetail({ pattern: '*.ts' })).toBe('*.ts')
    expect(toolDetail({ unknown_field: 'x' })).toBeUndefined()
  })

  it('flattens and truncates so a card stays one line', () => {
    expect(toolDetail({ command: 'a\n  b' })).toBe('a b')
    expect(toolDetail({ command: 'x'.repeat(300) })?.endsWith('…')).toBe(true)
    expect(toolDetail({ command: 'x'.repeat(300) })).toHaveLength(160)
  })
})
