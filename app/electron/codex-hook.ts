/**
 * Codex's `PreToolUse` hook for a Chat set to Ask first (see
 * `shared/codex-hook.ts`). Codex pipes the tool call in on stdin; this asks
 * the developer through the running app and prints Codex's decision. Anything
 * that keeps it from asking denies the call: this hook fails closed.
 */

import { requestBridge } from './bridge-client'
import { codexApprovalAsk, codexHookReply, type CodexHookInput } from '../shared/codex-hook'
import { DELEGATE_ENV, TASK_ENV, TOKEN_ENV } from '../shared/mcp-config'

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    let input = ''
    process.stdin.setEncoding('utf8')
    process.stdin.on('data', (chunk: string) => (input += chunk))
    process.stdin.on('end', () => resolve(input))
  })
}

async function decide(): Promise<{ allow: boolean; message?: string }> {
  let hook: CodexHookInput
  try {
    hook = JSON.parse(await readStdin()) as CodexHookInput
  } catch {
    return { allow: false, message: 'Farol could not read this tool call, so it was not run.' }
  }
  const ask = codexApprovalAsk(hook)
  if (!ask) return { allow: true }
  const delegateId = process.env[DELEGATE_ENV] || undefined
  const reply = await requestBridge({
    op: 'approve',
    token: process.env[TOKEN_ENV] ?? '',
    taskId: process.env[TASK_ENV] ?? '',
    toolName: ask.toolName,
    input: ask.input,
    ...(delegateId ? { delegateId } : {})
  })
  if (!reply || !reply.ok || reply.op !== 'approve') {
    return { allow: false, message: 'Farol could not ask the developer, so this was not run.' }
  }
  return { allow: reply.allow, ...(reply.message ? { message: reply.message } : {}) }
}

decide()
  .catch(() => ({ allow: false, message: 'Farol could not ask the developer, so this was not run.' }))
  .then((answer) => {
    const out = codexHookReply(answer)
    if (out) process.stdout.write(out)
    process.exit(0)
  })
