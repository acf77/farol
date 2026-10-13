import { execCli } from './exec-cli'
import { resolveBinFrom } from './bin'
import type { AgentScanResult } from '../shared/types'
import type { AiProvider } from '../shared/ai'

/** Onboarding's agents: each with the binary names it may be installed as. */
const SCANNED: [AiProvider, string[]][] = [
  ['claude', ['claude']],
  ['codex', ['codex']],
  ['opencode', ['opencode']],
  ['cursor', ['cursor-agent', 'agent']],
  ['omp', ['omp']]
]

const VERSION_TIMEOUT = 4000

export function parseVersion(out: string): string | undefined {
  return /\d+\.\d+(?:\.\d+)?(?:[-.\w]*)?/.exec(out)?.[0]
}

export async function scanAgents(): Promise<AgentScanResult[]> {
  return Promise.all(
    SCANNED.map(async ([provider, names]): Promise<AgentScanResult> => {
      const path = resolveBinFrom(names)
      if (!path) return { provider, found: false }
      const res = await execCli(path, process.cwd(), ['--version'], VERSION_TIMEOUT)
      const version = res.code === 0 ? parseVersion(res.out) : undefined
      return { provider, found: true, path, ...(version ? { version } : {}) }
    })
  )
}
