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

function isHidden(name: string): boolean {
  return name.startsWith('.') || SKIP_DIRS.has(name)
}

function readSkill(dir: string, file: string, provider: AiProvider): AgentSkill | null {
  const name = path.basename(dir)
  if (!isSkillName(name)) return null
  const src = readSkillFile(path.join(dir, file))
  if (src === null || !isUserInvocable(parseSkillFrontmatter(src))) return null
  return { name, token: skillToken(provider, name) }
}

/** `Dirent.isDirectory()` is false for a symlink, so installers that link skill folders need a stat. */
function isDirectory(dir: string): boolean {
  try {
    return fs.statSync(dir).isDirectory()
  } catch {
    return false
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
    const skill = readSkill(root, skillMd.name, provider)
    if (skill) out.push({ ...skill, rank })
    return
  }

  for (const entry of entries) {
    const dir = path.join(root, entry.name)
    if (!isHidden(entry.name) && isDirectory(dir)) collectFromRoot(dir, rank, provider, out)
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
