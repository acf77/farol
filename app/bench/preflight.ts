/**
 * Before a run, start each subject's CLI once the way managed Chat does (same
 * command, model, effort and permission mode) on a one-line prompt. A CLI that
 * cannot run (not signed in, a model the account cannot use, a usage limit)
 * otherwise fails every attempt of every case, each retried with backoff,
 * and the report would blame the model.
 */

import { execFileSync, spawn } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { aiEnv, resolveBinFrom } from '../electron/bin'
import { openRouterAgent } from '../electron/openrouter-agent'
import { managedAiCommand } from '../shared/ai'
import { AgentStreamParser } from '../shared/agent-stream'
import { plainText } from '../shared/terminal'
import type { Subject } from './types'

const PROMPT = 'Reply with the single word OK. Do not use any tools.'

/** The CLI's own explanation, or null when it answered. */
export async function preflight(subject: Subject, timeoutMs = 180_000): Promise<string | null> {
  const via = openRouterAgent()
  const spec = managedAiCommand(subject.provider, PROMPT, subject.model, { jsonFormat: true, via, mode: 'build', ...(subject.effort ? { effort: subject.effort } : {}) })
  const bin = resolveBinFrom(spec.bins)
  if (!bin) return spec.hint
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'farol-bench-preflight-'))
  execFileSync('git', ['init', '-q'], { cwd: dir })
  try {
    return await new Promise((resolve) => {
      const child = spawn(bin, spec.args, { cwd: dir, env: aiEnv(subject.provider, via), stdio: ['ignore', 'pipe', 'pipe'], detached: true })
      const parser = spec.stream === 'ndjson' ? new AgentStreamParser() : null
      let said = ''
      let stderr = ''
      const take = (events: ReturnType<AgentStreamParser['push']>): void => {
        for (const event of events) if (event.kind === 'text' || event.kind === 'raw') said += `${event.text}\n`
      }
      child.stdout.on('data', (chunk: Buffer) => {
        if (parser) take(parser.push(chunk.toString()))
        else said += plainText(chunk.toString())
      })
      child.stderr.on('data', (chunk: Buffer) => {
        stderr = (stderr + plainText(chunk.toString())).slice(-4000)
      })
      const timer = setTimeout(() => {
        try {
          if (child.pid) process.kill(-child.pid, 'SIGKILL')
        } catch {
          /* gone */
        }
      }, timeoutMs)
      child.on('error', (error) => {
        clearTimeout(timer)
        resolve(error.message)
      })
      child.on('close', (code, signal) => {
        clearTimeout(timer)
        if (parser) take(parser.flush())
        if (code === 0 && !parser?.failed) return resolve(null)
        const why = [said.trim(), stderr.trim()].filter(Boolean).join('\n') || (signal ? `killed (${signal}) after ${timeoutMs / 1000}s` : 'no output')
        resolve(`exit ${code ?? signal}: ${why.split('\n').slice(-6).join('\n')}`)
      })
    })
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}
