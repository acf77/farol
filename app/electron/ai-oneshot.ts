import { spawn } from 'child_process'
import { aiCommand, type AiProvider } from '../shared/ai'
import { errorMessage } from '../shared/jev'
import { applyOpencodeConfig } from '../shared/opencode-config'
import { aiEnv, resolveBinFrom } from './bin'
import { openRouterAgent } from './openrouter-agent'

/** Run a one-shot AI prompt and return stdout as plain text. */
export function runAiOnce(
  provider: AiProvider,
  prompt: string,
  cwd: string,
  timeoutMs = 120_000,
  model?: string
): Promise<{ ok: boolean; text: string; error?: string }> {
  const via = openRouterAgent()
  const spec = aiCommand(provider, prompt, model, via)
  const bin = resolveBinFrom(spec.bins)
  if (!bin) {
    const listed = spec.bins.map((b) => `'${b}'`).join(' or ')
    return Promise.resolve({ ok: false, text: '', error: `${listed} is not on PATH. ${spec.hint}` })
  }

  const env = aiEnv(provider, via)
  applyOpencodeConfig(env, spec.opencodeConfig)
  return new Promise((resolve) => {
    let stdout = ''
    let stderr = ''
    let proc: ReturnType<typeof spawn>
    try {
      proc = spawn(bin, spec.args, {
        cwd,
        env,
        stdio: ['ignore', 'pipe', 'pipe']
      })
    } catch (error) {
      resolve({ ok: false, text: '', error: errorMessage(error) })
      return
    }
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
