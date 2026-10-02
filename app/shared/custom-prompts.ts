/**
 * Custom prompts: user-written standing instructions that Farol adds to every
 * chat turn while they are active. Global prompts carry their own `active`
 * flag; project prompts come from a repo file, so whether they are active is
 * decided per machine and passed in separately.
 */

export const CUSTOM_INSTRUCTIONS_TAG = 'custom_instructions'
export const MAX_PROMPTS = 50
export const MAX_PROMPT_NAME = 80
export const MAX_PROMPT_BODY = 8000

export interface CustomPrompt {
  id: string
  name: string
  body: string
  active: boolean
  updatedAt: number
}

/** Everything Settings shows for one project, as the main process sees it. */
export interface CustomPromptSet {
  global: CustomPrompt[]
  project: CustomPrompt[]
  /** Project prompt ids switched on for this machine. */
  activeProjectIds: string[]
  /** Primary checkout the project prompts come from; null with no project. */
  projectRoot: string | null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function promptFrom(value: unknown): CustomPrompt | null {
  if (!isRecord(value)) return null
  const id = typeof value.id === 'string' ? value.id.trim() : ''
  const body = typeof value.body === 'string' ? value.body.trim().slice(0, MAX_PROMPT_BODY).trim() : ''
  if (!id || !body) return null
  const name =
    typeof value.name === 'string' ? value.name.replace(/\s+/g, ' ').trim().slice(0, MAX_PROMPT_NAME).trim() : ''
  const updatedAt =
    typeof value.updatedAt === 'number' && Number.isFinite(value.updatedAt) && value.updatedAt >= 0
      ? value.updatedAt
      : 0
  return { id, name: name || 'Untitled prompt', body, active: value.active === true, updatedAt }
}

/** Drop malformed entries, empty bodies, and repeated ids; clamp sizes. */
export function sanitizePrompts(raw: unknown): CustomPrompt[] {
  if (!Array.isArray(raw)) return []
  const out: CustomPrompt[] = []
  const seen = new Set<string>()
  for (const row of raw) {
    if (out.length >= MAX_PROMPTS) break
    const prompt = promptFrom(row)
    if (!prompt || seen.has(prompt.id)) continue
    seen.add(prompt.id)
    out.push(prompt)
  }
  return out
}

/** Neutralise tags that would let a prompt open or close the wrapper early. */
export function escapeCustomInstructions(text: string): string {
  return text.replace(new RegExp(`<(\\s*/?\\s*${CUSTOM_INSTRUCTIONS_TAG})`, 'gi'), '&lt;$1')
}

/**
 * The text added to a turn: every active prompt, global first, inside one
 * `<custom_instructions>` block. Empty when nothing is active.
 */
export function activePromptBlock(
  global: readonly CustomPrompt[],
  project: readonly CustomPrompt[],
  activeProjectIds: readonly string[]
): string {
  const projectActive = new Set(activeProjectIds)
  const picked = [
    ...global.filter((prompt) => prompt.active),
    ...project.filter((prompt) => projectActive.has(prompt.id))
  ]
  if (!picked.length) return ''
  const sections = picked.map(
    (prompt) => `### ${escapeCustomInstructions(prompt.name)}\n${escapeCustomInstructions(prompt.body)}`
  )
  return `<${CUSTOM_INSTRUCTIONS_TAG}>\n${sections.join('\n\n')}\n</${CUSTOM_INSTRUCTIONS_TAG}>`
}

/** Number of prompts that will be included in each chat turn. */
export function activePromptCount(set: CustomPromptSet): number {
  const projectActive = new Set(set.activeProjectIds)
  return (
    set.global.filter((prompt) => prompt.active).length +
    set.project.filter((prompt) => projectActive.has(prompt.id)).length
  )
}
