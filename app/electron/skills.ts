import fs from 'fs'
import os from 'os'
import path from 'path'
import type { AiProvider, OpenRouterAgent } from '../shared/ai'
import {
  effectiveSkills,
  isSkillName,
  isUserInvocable,
  parseSkillFrontmatter,
  skillRoots,
  skillToken,
  type AgentSkill
} from '../shared/skills'

const SKIP_DIRS = new Set(['node_modules', '.git'])

function readSkillFile(file: string): string | null {
  try {
    return fs.readFileSync(file, 'utf8')
  } catch {
    return null
  }
}

function collectFromRoot(
  root: string,
  rank: number,
  provider: AiProvider,
  out: Array<AgentSkill & { rank: number }>
): void {
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(root, { withFileTypes: true })
  } catch {
    return
  }

  const skillMd = entries.find((entry) => entry.isFile() && entry.name.toLowerCase() === 'skill.md')
  if (skillMd) {
    const name = path.basename(root)
    if (!isSkillName(name)) return
    const src = readSkillFile(path.join(root, skillMd.name))
    if (src === null || !isUserInvocable(parseSkillFrontmatter(src))) return
    out.push({ name, token: skillToken(provider, name), rank })
    return
  }

  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.') || SKIP_DIRS.has(entry.name)) continue
    collectFromRoot(path.join(root, entry.name), rank, provider, out)
  }
}

/** User-invocable skills the current agent would expose in its native slash picker. */
export function listAgentSkills(
  cwd: string,
  provider: AiProvider,
  home = os.homedir(),
  via?: OpenRouterAgent
): AgentSkill[] {
  if (typeof cwd !== 'string' || !cwd || !fs.existsSync(cwd)) return []
  const found: Array<AgentSkill & { rank: number }> = []
  for (const spec of skillRoots(provider, via)) {
    const base = spec.kind === 'user' ? home : cwd
    collectFromRoot(path.join(base, ...spec.rel.split('/')), spec.rank, provider, found)
  }
  return effectiveSkills(found)
}
