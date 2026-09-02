import { spawn } from 'child_process'
import { aiCommand, type AiProvider } from '../shared/ai'
import { aiEnv, resolveBinFrom } from './bin'

/** Run a one-shot AI prompt and return stdout as plain text. */
export function runAiOnce(
  provider: AiProvider,
  prompt: string,
  cwd: string,
  timeoutMs = 120_000,
  model?: string
): Promise<{ ok: boolean; text: string; error?: string }> {
  const spec = aiCommand(provider, prompt, model)
  const bin = resolveBinFrom(spec.bins)
  if (!bin) {
    const listed = spec.bins.map((b) => `'${b}'`).join(' or ')
    return Promise.resolve({ ok: false, text: '', error: `${listed} is not on PATH. ${spec.hint}` })
  }

  return new Promise((resolve) => {
    let stdout = ''
    let stderr = ''
    const proc = spawn(bin, spec.args, { cwd, env: aiEnv(), stdio: ['ignore', 'pipe', 'pipe'] })
    const timer = setTimeout(() => {
      proc.kill('SIGTERM')
    }, timeoutMs)

    proc.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString()
    })
    proc.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString()
    })
    proc.on('error', (err) => {
      clearTimeout(timer)
      resolve({ ok: false, text: '', error: err.message })
    })
    proc.on('close', (code) => {
      clearTimeout(timer)
      const text = (stdout || stderr).trim()
      if (code === 0 && text) resolve({ ok: true, text })
      else resolve({ ok: false, text, error: text || stderr.trim() || `exit ${code ?? 1}` })
    })
  })
}
