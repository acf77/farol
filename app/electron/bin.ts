import { randomUUID } from 'crypto'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { cliFor, usesOpenRouterEnv, type AiProvider, type OpenRouterAgent } from '../shared/ai'
import { OPENROUTER_API_KEY_ENV } from '../shared/openrouter'
import { peekSecret } from './secrets'
import { shellEnv } from './session'

export function extraBinDirs(): string[] {
  const home = os.homedir()
  const nvmDir = process.env.NVM_DIR || path.join(home, '.nvm')
  return [
    '/opt/homebrew/bin',
    '/usr/local/bin',
    path.join(home, '.local', 'bin'),
    path.join(home, '.cursor', 'bin'),
    path.join(home, '.opencode', 'bin'),
    path.join(home, '.npm-global', 'bin'),
    path.join(home, '.bun', 'bin'),
    path.join(home, '.volta', 'bin'),
    path.join(home, '.fnm', 'aliases', 'default', 'bin'),
    path.join(home, '.local', 'share', 'fnm', 'aliases', 'default', 'bin'),
    path.join(nvmDir, 'current', 'bin')
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

/**
 * OpenCode keeps every session in one SQLite db under XDG_DATA_HOME
 * (`~/.local/share/opencode/opencode.db`). Two concurrent OpenCode processes
 * writing it get "database is locked", so Farol gives each process a private
 * data home seeded with the user's credentials. OpenRouter can ride the same
 * binary, so the isolation follows `cliFor`, not the provider name.
 */
const OPENCODE_AUTH_FILES = ['auth.json', 'account.json'] as const
/** Where the shared OpenCode data (auth + the contended db) lives. */
const OPENCODE_DATA_HOME = path.join(os.homedir(), '.local', 'share', 'opencode')
/** Each isolated clone lives under a unique dir here; the OS reaps tmpdir. */
const OPENCODE_ISOLATION_ROOT = path.join(os.tmpdir(), 'farol-opencode')

/** Link the user's credentials into a fresh OpenCode data home, or copy when
 * symlinks are unavailable. Missing files only drop a provider, not the run. */
function seedOpencodeCredentials(target: string): void {
  for (const name of OPENCODE_AUTH_FILES) {
    const from = path.join(OPENCODE_DATA_HOME, name)
    if (!fs.existsSync(from)) continue
    const to = path.join(target, name)
    try {
      fs.symlinkSync(from, to)
    } catch {
      try {
        fs.copyFileSync(from, to)
      } catch {
        /* no credentials to seed */
      }
    }
  }
}

/** A private XDG_DATA_HOME so this process gets its own sqlite db, not the
 * shared one other sessions are writing. The dir is a fresh, unique tmpdir
 * entry the OS reclaims after the process ends. */
function isolatedOpencodeDataHome(): string {
  const root = path.join(OPENCODE_ISOLATION_ROOT, randomUUID())
  const target = path.join(root, 'opencode')
  fs.mkdirSync(target, { recursive: true })
  seedOpencodeCredentials(target)
  return root
}

export function aiEnv(provider?: AiProvider, via?: OpenRouterAgent): Record<string, string> {
  const env = shellEnv()
  env.PATH = pathDirs(env.PATH).join(path.delimiter)
  if (provider && usesOpenRouterEnv(provider)) {
    const key = peekSecret('openrouterApiKey')
    if (key) env[OPENROUTER_API_KEY_ENV] = key
  }
  if (provider && cliFor(provider, via) === 'opencode') env.XDG_DATA_HOME = isolatedOpencodeDataHome()
  return env
}
