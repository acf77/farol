import { describe, expect, it } from 'vitest'
import {
  codexApprovalAsk,
  codexHookArgs,
  codexHookCommand,
  codexHookReply,
  isCodexHookTrustWarning,
  patchedFiles
} from './codex-hook'

describe('codex hook', () => {
  it('asks about a shell call with its command', () => {
    expect(codexApprovalAsk({ tool_name: 'Bash', tool_input: { command: 'npm test' } })).toEqual({
      toolName: 'Bash',
      input: { command: 'npm test' }
    })
  })

  it('names the files a patch touches instead of the whole patch', () => {
    const patch = '*** Begin Patch\n*** Add File: a.txt\n+x\n*** Update File: src/b.ts\n@@\n-y\n+z\n*** Delete File: c.md\n*** End Patch\n'
    expect(patchedFiles(patch)).toEqual(['a.txt', 'src/b.ts', 'c.md'])
    expect(codexApprovalAsk({ tool_name: 'apply_patch', tool_input: { command: patch } })).toEqual({
      toolName: 'apply_patch',
      input: { file_path: 'a.txt, src/b.ts, c.md' }
    })
  })

  it('never asks about Farol’s own managed tools', () => {
    expect(codexApprovalAsk({ tool_name: 'mcp__farol-chat__delegate', tool_input: {} })).toBeUndefined()
    expect(codexApprovalAsk({ tool_name: 'farol-chat.delegate', tool_input: {} })).toBeUndefined()
  })

  it('prints nothing to allow and a reasoned deny otherwise', () => {
    expect(codexHookReply({ allow: true })).toBe('')
    expect(JSON.parse(codexHookReply({ allow: false, message: 'No.' }))).toEqual({
      hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'No.' }
    })
    // Codex rejects a deny without a reason.
    expect(JSON.parse(codexHookReply({ allow: false, message: ' ' })).hookSpecificOutput.permissionDecisionReason).toBe(
      'The developer declined this.'
    )
  })

  it('quotes the command line for the shell, env included', () => {
    expect(
      codexHookCommand({ command: "/Apps/Far ol.app/bin", args: ["/x/it's.js"], env: { A: '1', B: "o'k" } })
    ).toBe(`env A='1' B='o'\\''k' '/Apps/Far ol.app/bin' '/x/it'\\''s.js'`)
  })

  it('installs one PreToolUse hook with a long timeout, and the trust flag it needs', () => {
    const args = codexHookArgs("env A='1' '/bin/hook'")
    expect(args[0]).toBe('-c')
    expect(args[1]).toBe(
      `hooks.PreToolUse=[{ matcher = "*", hooks = [{ type = "command", command = "env A='1' '/bin/hook'", timeout = 86400 }] }]`
    )
    expect(args[2]).toBe('--dangerously-bypass-hook-trust')
  })

  it('recognises Codex’s warning about that flag', () => {
    expect(isCodexHookTrustWarning('`--dangerously-bypass-hook-trust` is enabled. Enabled hooks may run without review')).toBe(true)
    expect(isCodexHookTrustWarning('Quota exceeded')).toBe(false)
  })
})
