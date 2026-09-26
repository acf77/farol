import type { AiProvider } from './ai'
import { AI_LABELS, cliFor, type OpenRouterAgent } from './ai'

export interface AgentSkill {
  name: string
  token: string
}

export type SkillRootKind = 'project' | 'user'

export interface SkillRootSpec {
  kind: SkillRootKind
  /** Relative to the project cwd or the user home. */
  rel: string
  /** Higher wins when the same name appears in more than one root. */
  rank: number
}

const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const LEADING_SKILL = /^([/$])([a-z0-9]+(?:-[a-z0-9]+)*)/i

export function isSkillName(value: string): boolean {
  return SKILL_NAME.test(value)
}

export function skillToken(provider: AiProvider, name: string): string {
  return `${provider === 'codex' ? '$' : '/'}${name}`
}

/** Native SKILL.md roots for each coding CLI, lowest rank first. */
export function skillRoots(provider: AiProvider, via?: OpenRouterAgent): SkillRootSpec[] {
  switch (cliFor(provider, via)) {
    case 'claude':
      return [
        { kind: 'user', rel: '.claude/skills', rank: 1 },
        { kind: 'project', rel: '.claude/skills', rank: 10 }
      ]
    case 'cursor':
      return [
        { kind: 'user', rel: '.claude/skills', rank: 1 },
        { kind: 'user', rel: '.codex/skills', rank: 2 },
        { kind: 'user', rel: '.agents/skills', rank: 3 },
        { kind: 'user', rel: '.cursor/skills', rank: 4 },
        { kind: 'project', rel: '.claude/skills', rank: 10 },
        { kind: 'project', rel: '.codex/skills', rank: 11 },
        { kind: 'project', rel: '.agents/skills', rank: 12 },
        { kind: 'project', rel: '.cursor/skills', rank: 13 }
      ]
    case 'codex':
      return [
        { kind: 'user', rel: '.codex/skills', rank: 1 },
        { kind: 'user', rel: '.agents/skills', rank: 2 },
        { kind: 'project', rel: '.codex/skills', rank: 10 },
        { kind: 'project', rel: '.agents/skills', rank: 11 }
      ]
    case 'opencode':
      return [
        { kind: 'user', rel: '.agents/skills', rank: 1 },
        { kind: 'user', rel: '.claude/skills', rank: 2 },
        { kind: 'user', rel: '.config/opencode/skills', rank: 3 },
        { kind: 'project', rel: '.agents/skills', rank: 10 },
        { kind: 'project', rel: '.claude/skills', rank: 11 },
        { kind: 'project', rel: '.opencode/skills', rank: 12 }
      ]
    case 'omp':
      // omp reads `~/.claude/skills` only behind an opt-in, so it is left out.
      return [
        { kind: 'user', rel: '.omp/agent/skills', rank: 1 },
        { kind: 'user', rel: '.agents/skills', rank: 2 },
        { kind: 'project', rel: '.agents/skills', rank: 10 },
        { kind: 'project', rel: '.claude/skills', rank: 11 },
        { kind: 'project', rel: '.omp/skills', rank: 12 }
      ]
    case 'pi':
      // Pi reads Claude/Codex skill dirs only when settings.json lists them.
      return [
        { kind: 'user', rel: '.pi/agent/skills', rank: 1 },
        { kind: 'user', rel: '.agents/skills', rank: 2 },
        { kind: 'project', rel: '.agents/skills', rank: 10 },
        { kind: 'project', rel: '.pi/skills', rank: 11 }
      ]
  }
}

export function parseSkillFrontmatter(src: string): Record<string, string> {
  const block = /^---\r?\n([\s\S]*?)\r?\n---/.exec(src)
  if (!block) return {}
  const out: Record<string, string> = {}
  for (const line of block[1].split(/\r?\n/)) {
    const pair = /^([A-Za-z0-9_-]+)\s*:\s*(.*?)\s*$/.exec(line)
    if (!pair) continue
    out[pair[1]] = pair[2].replace(/^['"]|['"]$/g, '')
  }
  return out
}

/** Hidden from the provider's own slash picker. */
export function isUserInvocable(meta: Record<string, string>): boolean {
  const user = meta['user-invocable'] ?? meta.user_invocable
  if (user === 'false' || user === 'no') return false
  if (meta.slash === 'false' || meta.slash === 'no') return false
  return true
}

export function effectiveSkills(
  found: Array<AgentSkill & { rank: number }>
): AgentSkill[] {
  const best = new Map<string, AgentSkill & { rank: number }>()
  for (const skill of found) {
    const cur = best.get(skill.name)
    if (!cur || skill.rank >= cur.rank) best.set(skill.name, skill)
  }
  return [...best.values()]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map(({ name, token }) => ({ name, token }))
}

/** `/` at the start of the message, caret still on that token. */
export function skillMenuQuery(text: string, caret: number): string | null {
  if (!text.startsWith('/')) return null
  const nl = text.indexOf('\n')
  const line = nl === -1 ? text : text.slice(0, nl)
  const match = /^\/(\S*)$/.exec(line)
  if (!match) return null
  if (caret < 1 || caret > line.length) return null
  return match[1]
}

export function filterSkills(skills: readonly AgentSkill[], query: string): AgentSkill[] {
  const needle = query.trim().toLowerCase()
  const hits = needle ? skills.filter((skill) => skill.name.includes(needle)) : [...skills]
  return hits.slice(0, 40)
}

export function insertSkillText(text: string, token: string): { text: string; caret: number } {
  const rest = text.replace(/^\/\S*/, '').replace(/^\s+/, '')
  const next = rest ? `${token} ${rest}` : `${token} `
  return { text: next, caret: token.length + 1 }
}

export function convertSkillDraft(
  text: string,
  nextProvider: AiProvider,
  nextNames: ReadonlySet<string>,
  prevNames: ReadonlySet<string>
): { text: string; unavailable: string[] } {
  const match = LEADING_SKILL.exec(text)
  if (!match) return { text, unavailable: [] }
  const name = match[2].toLowerCase()
  if (!isSkillName(name)) return { text, unavailable: [] }
  const tail = text.slice(match[0].length)
  if (nextNames.has(name)) return { text: `${skillToken(nextProvider, name)}${tail}`, unavailable: [] }
  if (prevNames.has(name)) return { text, unavailable: [name] }
  return { text, unavailable: [] }
}

export function retainSkillWarning(text: string, names: readonly string[]): string[] {
  return names.filter((name) => text.includes(`/${name}`) || text.includes(`$${name}`))
}

export function skillWarningLine(names: readonly string[], provider: AiProvider): string | null {
  if (!names.length) return null
  const who = names.join(', ')
  const verb = names.length === 1 ? 'is' : 'are'
  return `${who} ${verb} not available for ${AI_LABELS[provider]}.`
}
