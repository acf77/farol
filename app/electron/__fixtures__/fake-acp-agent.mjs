// A scripted ACP agent for acp-run tests. Behaviour comes from FAKE_ACP (JSON):
// { modes: ['build','plan'], resume: true, resumeFails: false, permission: true, noAcp: false }
import fs from 'fs'
import process from 'process'
const cfg = JSON.parse(process.env.FAKE_ACP || '{}')
if (cfg.noAcp) process.exit(0)
const log = (entry) => cfg.log && fs.appendFileSync(cfg.log, JSON.stringify(entry) + '\n')
let buf = ''
let nextId = 1000
const waiting = new Map()
const send = (m) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\n')
const ask = (method, params) => new Promise((res) => { const id = ++nextId; waiting.set(id, res); send({ id, method, params }) })
const update = (sessionId, u) => send({ method: 'session/update', params: { sessionId, update: u } })
const configOptions = () => [{ id: 'mode', type: 'select', currentValue: (cfg.modes ?? ['build'])[0], options: (cfg.modes ?? ['build']).map((value) => ({ value })) }]
process.stdin.on('data', async (d) => {
  buf += d
  let n
  while ((n = buf.indexOf('\n')) >= 0) {
    const m = JSON.parse(buf.slice(0, n)); buf = buf.slice(n + 1)
    if (!m.method) { waiting.get(m.id)?.(m); waiting.delete(m.id); continue }
    log({ method: m.method, params: m.params })
    const p = m.params ?? {}
    if (m.method === 'initialize') send({ id: m.id, result: { protocolVersion: 1, agentCapabilities: { sessionCapabilities: cfg.resume ? { resume: {} } : {} } } })
    else if (m.method === 'session/new') send({ id: m.id, result: { sessionId: 'ses_1', configOptions: configOptions() } })
    else if (m.method === 'session/resume') send(cfg.resumeFails ? { id: m.id, error: { code: -32602, message: 'Session not found' } } : { id: m.id, result: { configOptions: configOptions() } })
    else if (m.method === 'session/set_config_option') send({ id: m.id, result: { configOptions: configOptions() } })
    else if (m.method === 'session/prompt') {
      const sid = p.sessionId
      update(sid, { sessionUpdate: 'tool_call', toolCallId: 'c1', title: 'bash', kind: 'execute', status: 'pending', rawInput: {} })
      update(sid, { sessionUpdate: 'tool_call_update', toolCallId: 'c1', title: 'echo hi', kind: 'execute', status: 'in_progress', rawInput: { command: 'echo hi' } })
      let allowed = true
      if (cfg.permission) {
        const reply = await ask('session/request_permission', { sessionId: sid, toolCall: { toolCallId: 'c1', title: 'echo hi', kind: 'execute', rawInput: { command: 'echo hi' } }, options: [{ optionId: 'once', kind: 'allow_once', name: 'Allow once' }, { optionId: 'always', kind: 'allow_always', name: 'Always' }, { optionId: 'reject', kind: 'reject_once', name: 'Reject' }] })
        log({ permissionReply: reply.result })
        allowed = reply.result?.outcome?.optionId === 'once'
      }
      update(sid, { sessionUpdate: 'tool_call_update', toolCallId: 'c1', status: allowed ? 'completed' : 'failed' })
      update(sid, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: allowed ? 'Ran it.' : 'Not allowed.' } })
      send({ id: m.id, result: { stopReason: 'end_turn', usage: { inputTokens: 4321, outputTokens: 7 } } })
    } else send({ id: m.id, error: { code: -32601, message: 'unknown' } })
  }
})
