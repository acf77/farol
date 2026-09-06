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

  it('turns a question tool_use into a question event, not a tool card', () => {
    const parser = new AgentStreamParser()
    const asked = JSON.stringify({
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            id: 'toolu_q',
            name: 'AskUserQuestion',
            input: {
              questions: [
                {
                  question: 'Which database should we use?',
                  header: 'Database',
                  options: [
                    { label: 'Postgres', description: 'Existing stack' },
                    { label: 'SQLite', description: 'Local file' }
                  ]
                }
              ]
            }
          }
        ]
      }
    })
    const result = JSON.stringify({
      type: 'user',
      message: {
        role: 'user',
        content: [{ tool_use_id: 'toolu_q', type: 'tool_result', content: 'ok', is_error: false }]
      }
    })
    expect(parse(parser, `${asked}\n${result}\n`)).toEqual([
      {
        kind: 'question',
        toolId: 'toolu_q',
        questions: [
          {
            question: 'Which database should we use?',
            header: 'Database',
            options: [
              { label: 'Postgres', description: 'Existing stack' },
              { label: 'SQLite', description: 'Local file' }
            ]
          }
        ]
      }
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
  })

  it('drops broken provider JSON instead of dumping it into Chat', () => {
    const parser = new AgentStreamParser()
    expect(parse(parser, '{"type":"assistant",BROKEN\n')).toEqual([])
  })

  it('recovers a Codex shell card from truncated item.completed JSON', () => {
    const parser = new AgentStreamParser()
    // Real Codex lines put identifying fields before the huge aggregated_output.
    // Truncation mid-string must still close the spinner — never print the JSON.
    const truncated =
      '{"type":"item.completed","item":{"id":"item_148","type":"command_execution",' +
      '"command":"/bin/zsh -lc oxlint","status":"completed","exit_code":1,' +
      '"aggregated_output":"file.js\\n  ! error\\nTHIS IS CUT'
    expect(parse(parser, `${truncated}\n`)).toEqual([
      {
        kind: 'tool',
        toolId: 'item_148',
        name: 'shell',
        detail: '/bin/zsh -lc oxlint',
        state: 'error'
      }
    ])
  })

  it('recovers a Codex shell card when an oversized line hits the buffer cap', () => {
    const parser = new AgentStreamParser()
    const prefix =
      '{"type":"item.completed","item":{"id":"item_99","type":"command_execution",' +
      '"command":"npm test","status":"completed","exit_code":0,"aggregated_output":"'
    // 8MB+ without a newline trips MAX_LINE; only the prefix is needed to recover.
    const huge = `${prefix}${'x'.repeat(8_100_000)}`
    expect(parse(parser, huge)).toEqual([
      {
        kind: 'tool',
        toolId: 'item_99',
        name: 'shell',
        detail: 'npm test',
        state: 'done'
      }
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

  it('reads Codex command lifecycle events and assistant messages', () => {
    const parser = new AgentStreamParser()
    const started = JSON.stringify({
      type: 'item.started',
      item: {
        id: 'item_1',
        type: 'command_execution',
        command: '/bin/zsh -lc pwd',
        status: 'in_progress'
      }
    })
    const completed = JSON.stringify({
      type: 'item.completed',
      item: {
        id: 'item_1',
        type: 'command_execution',
        command: '/bin/zsh -lc pwd',
        status: 'completed',
        exit_code: 0
      }
    })
    const message = JSON.stringify({
      type: 'item.completed',
      item: { id: 'item_2', type: 'agent_message', text: 'Done.' }
    })
    expect(parse(parser, `${started}\n${completed}\n${message}\n`)).toEqual([
      { kind: 'tool', toolId: 'item_1', name: 'shell', detail: '/bin/zsh -lc pwd', state: 'running' },
      { kind: 'tool', toolId: 'item_1', name: 'shell', detail: '/bin/zsh -lc pwd', state: 'done' },
      { kind: 'text', text: 'Done.' }
    ])
  })

  it('maps Codex file, MCP, web, and failed command items to tool cards', () => {
    const parser = new AgentStreamParser()
    // file_change / web_search often arrive only as item.completed (no started).
    const events = [
      {
        type: 'item.completed',
        item: {
          id: 'edit_1',
          type: 'file_change',
          changes: [{ path: 'src/app.ts' }],
          status: 'completed'
        }
      },
      {
        type: 'item.completed',
        item: {
          id: 'mcp_1',
          type: 'mcp_tool_call',
          server: 'docs',
          tool: 'search',
          arguments: { query: 'Codex JSONL' },
          status: 'completed'
        }
      },
      {
        type: 'item.completed',
        item: { id: 'web_1', type: 'webSearch', query: 'Codex app server', status: 'completed' }
      },
      {
        type: 'item.completed',
        item: {
          id: 'cmd_2',
          type: 'commandExecution',
          command: 'npm test',
          status: 'failed',
          exitCode: 1
        }
      }
    ].map((event) => JSON.stringify(event))
    expect(parse(parser, `${events.join('\n')}\n`)).toEqual([
      { kind: 'tool', toolId: 'edit_1', name: 'apply_patch', detail: 'src/app.ts', state: 'done' },
      { kind: 'tool', toolId: 'mcp_1', name: 'docs.search', detail: 'Codex JSONL', state: 'done' },
      { kind: 'tool', toolId: 'web_1', name: 'web_search', detail: 'Codex app server', state: 'done' },
      { kind: 'tool', toolId: 'cmd_2', name: 'shell', detail: 'npm test', state: 'error' }
    ])
  })

  it('keeps plan cards live on Codex item.updated events', () => {
    const parser = new AgentStreamParser()
    const started = JSON.stringify({
      type: 'item.started',
      item: { id: 'todo_1', type: 'todo_list', status: 'in_progress' }
    })
    const updated = JSON.stringify({
      type: 'item.updated',
      item: { id: 'todo_1', type: 'todo_list', status: 'in_progress' }
    })
    expect(parse(parser, `${started}\n${updated}\n`)).toEqual([
      { kind: 'tool', toolId: 'todo_1', name: 'update_plan', state: 'running' },
      { kind: 'tool', toolId: 'todo_1', name: 'update_plan', state: 'running' }
    ])
  })

  it('surfaces a Codex turn failure instead of dropping its JSON', () => {
    const parser = new AgentStreamParser()
    const failed = JSON.stringify({
      type: 'turn.failed',
      error: { message: 'Usage limit exceeded' }
    })
    expect(parse(parser, `${failed}\n`)).toEqual([
      { kind: 'raw', text: 'Usage limit exceeded\n' }
    ])
  })

  it('surfaces a top-level Codex error event (auth/quota) in Chat', () => {
    const parser = new AgentStreamParser()
    const error = JSON.stringify({
      type: 'error',
      error: { message: 'Authentication failed' }
    })
    expect(parse(parser, `${error}\n`)).toEqual([
      { kind: 'raw', text: 'Authentication failed\n' }
    ])
  })

  it('drops transient Codex reconnect noise from the transcript', () => {
    const parser = new AgentStreamParser()
    const reconnect = JSON.stringify({
      type: 'error',
      error: { message: 'Reconnecting to the app server…' }
    })
    expect(parse(parser, `${reconnect}\n`)).toEqual([])
  })

  it('ignores an unknown event type rather than showing its JSON', () => {
    const parser = new AgentStreamParser()
    expect(parse(parser, `${JSON.stringify({ type: 'something_new', data: 1 })}\n`)).toEqual([])
  })

  it('reads OpenCode --format json text and tool_use events', () => {
    const parser = new AgentStreamParser()
    const tool = JSON.stringify({
      type: 'tool_use',
      part: {
        id: 'prt_1',
        callID: 'call_bash',
        tool: 'bash',
        state: {
          status: 'completed',
          input: { command: 'echo hello', description: 'Print hello' },
          title: 'Print hello',
          metadata: { exit: 0 }
        }
      }
    })
    const write = JSON.stringify({
      type: 'tool_use',
      part: {
        callID: 'call_write',
        tool: 'write',
        state: { status: 'completed', input: { path: 'src/app.ts' } }
      }
    })
    const text = JSON.stringify({
      type: 'text',
      part: { type: 'text', text: 'Contains just: "hello".' }
    })
    const noise = [
      JSON.stringify({ type: 'step_start', part: { type: 'step-start' } }),
      JSON.stringify({ type: 'step_finish', part: { type: 'step-finish', reason: 'stop' } }),
      JSON.stringify({ type: 'reasoning', part: { type: 'reasoning', text: 'thinking' } })
    ].join('\n')
    expect(parse(parser, `${noise}\n`)).toEqual([])
    expect(parse(parser, `${tool}\n${write}\n${text}\n`)).toEqual([
      { kind: 'tool', toolId: 'call_bash', name: 'bash', detail: 'echo hello', state: 'done' },
      { kind: 'tool', toolId: 'call_write', name: 'write', detail: 'src/app.ts', state: 'done' },
      { kind: 'text', text: 'Contains just: "hello".' }
    ])
  })

  it('marks a failed OpenCode tool and nested session error', () => {
    const parser = new AgentStreamParser()
    const failed = JSON.stringify({
      type: 'tool_use',
      part: {
        callID: 'call_err',
        tool: 'bash',
        state: { status: 'completed', input: { command: 'false' }, metadata: { exit: 1 } }
      }
    })
    const errored = JSON.stringify({
      type: 'tool_use',
      part: {
        callID: 'call_fail',
        tool: 'read',
        state: { status: 'error', input: { path: 'missing.ts' }, error: 'ENOENT' }
      }
    })
    const session = JSON.stringify({
      type: 'error',
      error: { name: 'APIError', data: { message: 'Rate limit exceeded' } }
    })
    expect(parse(parser, `${failed}\n${errored}\n${session}\n`)).toEqual([
      { kind: 'tool', toolId: 'call_err', name: 'bash', detail: 'false', state: 'error' },
      { kind: 'tool', toolId: 'call_fail', name: 'read', detail: 'missing.ts', state: 'error' },
      { kind: 'raw', text: 'Rate limit exceeded\n' }
    ])
  })

  it('turns an OpenCode question tool_use into a question event', () => {
    const parser = new AgentStreamParser()
    const asked = JSON.stringify({
      type: 'tool_use',
      part: {
        callID: 'call_q',
        tool: 'question',
        state: {
          status: 'completed',
          input: {
            questions: [
              {
                question: 'Which database should we use?',
                header: 'Database',
                options: [
                  { label: 'Postgres', description: 'Existing stack' },
                  { label: 'SQLite', description: 'Local file' }
                ]
              }
            ]
          }
        }
      }
    })
    expect(parse(parser, `${asked}\n`)).toEqual([
      {
        kind: 'question',
        toolId: 'call_q',
        questions: [
          {
            question: 'Which database should we use?',
            header: 'Database',
            options: [
              { label: 'Postgres', description: 'Existing stack' },
              { label: 'SQLite', description: 'Local file' }
            ]
          }
        ]
      }
    ])
  })

  it('recovers an OpenCode tool card from truncated tool_use JSON', () => {
    const parser = new AgentStreamParser()
    const truncated =
      '{"type":"tool_use","part":{"id":"prt_9","callID":"call_big","tool":"bash",' +
      '"state":{"status":"completed","input":{"command":"npm test"},"output":"FAIL'
    expect(parse(parser, `${truncated}\n`)).toEqual([
      { kind: 'tool', toolId: 'call_big', name: 'bash', detail: 'npm test', state: 'done' }
    ])
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
