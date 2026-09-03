import fs from 'fs'
import os from 'os'
import path from 'path'
import { usesOpenRouterEnv, type AiProvider } from '../shared/ai'
import { OPENROUTER_API_KEY_ENV } from '../shared/openrouter'
import { peekOpenRouterKey } from './secrets'
import { shellEnv } from './session'

export function extraBinDirs(): string[] {
  const home = os.homedir()
  return [
    '/opt/homebrew/bin',
    '/usr/local/bin',
    path.join(home, '.local', 'bin'),
    path.join(home, '.cursor', 'bin'),
    path.join(home, '.npm-global', 'bin'),
    path.join(home, '.bun', 'bin')
  ]
}

function pathDirs(envPath?: string): string[] {
  const fromPath = (envPath ?? process.env.PATH ?? '').split(path.delimiter).filter(Boolean)
  const extra = extraBinDirs().filter((dir) => !fromPath.includes(dir))
  return [...extra, ...fromPath]
}

export function searchDirs(): string[] {
  return pathDirs()
}

export function resolveBin(name: string, dirs: string[] = searchDirs()): string | null {
  if (name.includes(path.sep)) return fs.existsSync(name) ? name : null
  const exts = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : ['']
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = path.join(dir, name + ext)
      try {
        fs.accessSync(candidate, fs.constants.X_OK)
        return candidate
      } catch {
        /* keep looking */
      }
    }
  }
  return null
}

/** First executable from a list of candidate names. */
export function resolveBinFrom(names: string[], dirs: string[] = searchDirs()): string | null {
  for (const name of names) {
    const bin = resolveBin(name, dirs)
    if (bin) return bin
  }
  return null
}

export function aiEnv(provider?: AiProvider): Record<string, string> {
  const env = shellEnv()
  env.PATH = pathDirs(env.PATH).join(path.delimiter)
  if (provider && usesOpenRouterEnv(provider)) {
    const key = peekOpenRouterKey()
    if (key) env[OPENROUTER_API_KEY_ENV] = key
  }
  return env
}
