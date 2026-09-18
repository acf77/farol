import type { Pipeline, PipelineNode, PipelineStepResult, Step, StepType } from './types'
import { normalizeAi, normalizeModel, type AiProvider } from './ai'

const AS_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/
const VAR_REF_RE = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g

function aiFields(raw: { ai?: unknown; model?: unknown }): { ai: AiProvider; model?: string } {
  const ai = normalizeAi(raw.ai)
  const model = normalizeModel(raw.model)
  return model ? { ai, model } : { ai }
}

/** Keep a valid simple id; clear anything else. */
export function sanitizeAs(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined
  const name = raw.trim()
  return name && AS_NAME_RE.test(name) ? name : undefined
}

function withAs<T extends object>(base: T, raw: unknown): T & { as?: string } {
  const as = sanitizeAs(raw)
  return as ? { ...base, as } : base
}

/** Expand `${name}` from `vars`; missing → `""`. Non-id `${…}` unchanged. */
export function expandVars(text: string, vars: Readonly<Record<string, string>>): string {
  return text.replace(VAR_REF_RE, (_, name: string) => vars[name] ?? '')
}

export function defaultGate(type: StepType): boolean {
  return type === 'shell'
}

export function nodeGate(n: PipelineNode): boolean {
  return n.gate ?? defaultGate(n.type)
}

export function chainToNodes(steps: Step[]): PipelineNode[] {
  return steps.map((s, i) =>
    withAs(
      {
        id: `n${i + 1}`,
        name: s.name,
        type: s.type,
        cmd: s.cmd,
        ...(s.type === 'ai' ? aiFields(s) : {}),
        after: i === 0 ? [] : [`n${i}`],
        gate: defaultGate(s.type),
        x: 72,
        y: 48 + i * 112
      },
      s.as
    )
  )
}

export function nextNodeId(nodes: PipelineNode[]): string {
  let max = 0
  for (const n of nodes) {
    const m = /^n(\d+)$/.exec(n.id)
    if (m) max = Math.max(max, Number(m[1]))
  }
  return `n${max + 1}`
}

export function newNodePos(nodes: PipelineNode[]): { x: number; y: number } {
  if (!nodes.length) return { x: 72, y: 48 }
  const maxY = Math.max(...nodes.map((n) => n.y))
  return { x: 72, y: maxY + 112 }
}

/** One blank editable node, placed after the existing graph. */
export function newPipelineNode(nodes: PipelineNode[], type: StepType): PipelineNode {
  return {
    id: nextNodeId(nodes),
    name: type === 'ai' ? 'AI step' : 'Shell step',
    type,
    cmd: '',
    ...(type === 'ai' ? { ai: 'claude' as const } : {}),
    after: [],
    gate: defaultGate(type),
    ...newNodePos(nodes)
  }
}

function incomingCount(nodes: PipelineNode[], byId: Map<string, PipelineNode>): Map<string, number> {
  const indeg = new Map<string, number>()
  for (const n of nodes) indeg.set(n.id, 0)
  for (const n of nodes) {
    for (const p of n.after) {
      if (!byId.has(p)) continue
      indeg.set(n.id, (indeg.get(n.id) ?? 0) + 1)
    }
  }
  return indeg
}

function releaseDependents(
  nodes: PipelineNode[],
  id: string,
  indeg: Map<string, number>,
  queue: string[]
): void {
  for (const c of nodes) {
    if (!c.after.includes(id)) continue
    const d = (indeg.get(c.id) ?? 1) - 1
    indeg.set(c.id, d)
    if (d === 0) queue.push(c.id)
  }
}

export function topoSort(nodes: PipelineNode[]): PipelineNode[] | null {
  const byId = new Map(nodes.map((n) => [n.id, n]))
  const indeg = incomingCount(nodes, byId)
  const queue = nodes.filter((n) => (indeg.get(n.id) ?? 0) === 0).map((n) => n.id)
  const out: PipelineNode[] = []
  while (queue.length) {
    const id = queue.shift() as string
    const n = byId.get(id)
    if (n) out.push(n)
    releaseDependents(nodes, id, indeg, queue)
  }
  return out.length === nodes.length ? out : null
}

/** Nodes that can start: not finished, every parent finished. */
export function readyIds(
  nodes: PipelineNode[],
  done: ReadonlySet<string>,
  skipped: ReadonlySet<string>,
  started: ReadonlySet<string>
): string[] {
  const finished = new Set([...done, ...skipped])
  return nodes
    .filter((n) => {
      if (started.has(n.id) || finished.has(n.id)) return false
      return n.after.every((p) => !nodes.some((x) => x.id === p) || finished.has(p))
    })
    .map((n) => n.id)
}

/** Downstream cone of `id` (children, grandchildren, …). */
export function descendants(nodes: PipelineNode[], id: string): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  const q = nodes.filter((n) => n.after.includes(id)).map((n) => n.id)
  while (q.length) {
    const cur = q.shift() as string
    if (seen.has(cur)) continue
    seen.add(cur)
    out.push(cur)
    for (const n of nodes) if (n.after.includes(cur)) q.push(n.id)
  }
  return out
}

export function ancestors(nodes: PipelineNode[], id: string): string[] {
  const byId = new Map(nodes.map((n) => [n.id, n]))
  const seen = new Set<string>()
  const walk = (nid: string): void => {
    const n = byId.get(nid)
    if (!n) return
    for (const p of n.after) {
      if (seen.has(p) || !byId.has(p)) continue
      seen.add(p)
      walk(p)
    }
  }
  walk(id)
  return [...seen]
}

/** Ancestor named outputs for `consumerId` (topo last-wins; fail/skip → `""`). */
export function ancestorVars(
  nodes: PipelineNode[],
  consumerId: string,
  outputsById: Readonly<Record<string, string>>,
  stepResults: ReadonlyMap<string, Pick<PipelineStepResult, 'ok' | 'skipped'>>
): Record<string, string> {
  const ancestorIds = new Set(ancestors(nodes, consumerId))
  const vars: Record<string, string> = {}
  for (const n of topoSort(nodes) ?? nodes) {
    if (!ancestorIds.has(n.id) || !n.as) continue
    vars[n.as] = stepResults.get(n.id)?.ok ? outputsById[n.id] || '' : ''
  }
  return vars
}

/** True when neither id is an ancestor of the other (they can run concurrently). */
function concurrentPair(anc: Map<string, Set<string>>, a: string, b: string): boolean {
  return !anc.get(a)?.has(b) && !anc.get(b)?.has(a)
}

/** Ids that share an `as` with a concurrent sibling (neither is an ancestor). */
export function parallelAsClashIds(nodes: PipelineNode[]): Set<string> {
  const anc = new Map(nodes.map((n) => [n.id, new Set(ancestors(nodes, n.id))]))
  const clash = new Set<string>()
  for (let i = 0; i < nodes.length; i++) {
    const a = nodes[i]
    if (!a.as) continue
    for (let j = i + 1; j < nodes.length; j++) {
      const b = nodes[j]
      if (b.as !== a.as || !concurrentPair(anc, a.id, b.id)) continue
      clash.add(a.id)
      clash.add(b.id)
    }
  }
  return clash
}

/** Connector above a node in topo order: `and` when it shares parents with the previous node. */
export function connectorKind(topo: PipelineNode[], index: number): 'then' | 'and' {
  if (index <= 0) return 'then'
  const key = (n: PipelineNode): string => [...n.after].sort().join('\0')
  return key(topo[index]) === key(topo[index - 1]) ? 'and' : 'then'
}

/** One step as the read-only chain shows it: its number and the word above it. */
export interface ChainStep {
  node: PipelineNode
  /** 1-based reading position across the whole chain. */
  index: number
  /** `then` on the first step of a level, `and` on a sibling beside it, null at the start. */
  join: 'then' | 'and' | null
}

/** A row of steps that start together — every parent of each sits in an earlier level. */
export interface ChainLevel {
  steps: ChainStep[]
}

function parentDepth(n: PipelineNode, ids: Set<string>, depth: Map<string, number>): number {
  let d = 0
  for (const p of n.after) {
    if (!ids.has(p)) continue
    d = Math.max(d, (depth.get(p) ?? 0) + 1)
  }
  return d
}

function nodeDepths(nodes: PipelineNode[]): Map<string, number> {
  const order = topoSort(nodes)
  if (!order) return new Map(nodes.map((n, i) => [n.id, i]))
  const ids = new Set(nodes.map((n) => n.id))
  const depth = new Map<string, number>()
  for (const n of order) depth.set(n.id, parentDepth(n, ids, depth))
  return depth
}

function chainJoin(level: number, step: number): ChainStep['join'] {
  if (!level && !step) return null
  return step ? 'and' : 'then'
}

/**
 * Group nodes into the levels the graph actually has: a node sits one step
 * below its deepest parent, so nodes that genuinely run at the same time land
 * in the same level. Topo order alone would hand back a single file and invent
 * a sequence the canvas never drew. A cycle has no honest level, so it falls
 * back to one node per level in declaration order.
 */
export function chainLevels(nodes: PipelineNode[]): ChainLevel[] {
  const depth = nodeDepths(nodes)
  // Declaration order inside a level, so the rows stay stable across renders.
  const rows = new Map<number, PipelineNode[]>()
  for (const n of nodes) {
    const d = depth.get(n.id) ?? 0
    const row = rows.get(d)
    if (row) row.push(n)
    else rows.set(d, [n])
  }

  let index = 0
  return [...rows.keys()]
    .sort((a, b) => a - b)
    .map((d, li): ChainLevel => ({
      steps: (rows.get(d) ?? []).map(
        (node, si): ChainStep => ({
          node,
          index: ++index,
          join: chainJoin(li, si)
        })
      )
    }))
}

function sanitizeNode(raw: unknown, fallbackId: string): PipelineNode | null {
  if (!raw || typeof raw !== 'object') return null
  const n = raw as Record<string, unknown>
  const type: StepType = n.type === 'ai' ? 'ai' : 'shell'
  const id = typeof n.id === 'string' && n.id ? n.id : fallbackId
  const after = Array.isArray(n.after)
    ? n.after.filter((x): x is string => typeof x === 'string' && x !== id)
    : []
  const x = typeof n.x === 'number' && Number.isFinite(n.x) ? n.x : 72
  const y = typeof n.y === 'number' && Number.isFinite(n.y) ? n.y : 48
  const gate = typeof n.gate === 'boolean' ? n.gate : defaultGate(type)
  return withAs(
    {
      id,
      name: typeof n.name === 'string' ? n.name : '',
      type,
      cmd: typeof n.cmd === 'string' ? n.cmd : '',
      ...(type === 'ai' ? aiFields(n) : {}),
      after,
      gate,
      x,
      y
    },
    n.as
  )
}

function sanitizeStep(raw: unknown): Step | null {
  if (!raw || typeof raw !== 'object') return null
  const s = raw as Record<string, unknown>
  const type: StepType = s.type === 'ai' ? 'ai' : 'shell'
  return withAs(
    {
      name: typeof s.name === 'string' ? s.name : '',
      type,
      cmd: typeof s.cmd === 'string' ? s.cmd : '',
      ...(type === 'ai' ? aiFields(s) : {})
    },
    s.as
  )
}

function nodesFromPersisted(p: Record<string, unknown>): PipelineNode[] {
  if (Array.isArray(p.nodes) && p.nodes.length) {
    return p.nodes.flatMap((n, i) => {
      const node = sanitizeNode(n, `n${i + 1}`)
      return node ? [node] : []
    })
  }
  if (Array.isArray(p.steps) && p.steps.length) {
    return chainToNodes(
      p.steps.flatMap((s) => {
        const step = sanitizeStep(s)
        return step ? [step] : []
      })
    )
  }
  return []
}

function normalizeGraph(nodes: PipelineNode[]): PipelineNode[] {
  // Drop duplicate ids — maps keyed by id would otherwise overwrite mid-run.
  const seen = new Set<string>()
  const unique = nodes.filter((n) => {
    if (seen.has(n.id)) return false
    seen.add(n.id)
    return true
  })
  const ids = new Set(unique.map((n) => n.id))
  const linked = unique.map((n) => ({ ...n, after: n.after.filter((a) => ids.has(a)) }))
  if (topoSort(linked)) return linked
  return linked.map((n, i) => ({
    ...n,
    after: i === 0 ? [] : [linked[i - 1].id]
  }))
}

export function sanitizePipeline(raw: unknown): Pipeline | null {
  if (!raw || typeof raw !== 'object') return null
  const p = raw as Record<string, unknown>
  if (typeof p.id !== 'string' || typeof p.name !== 'string') return null
  return {
    id: p.id,
    name: p.name,
    nodes: normalizeGraph(nodesFromPersisted(p)),
    ...(p.mandatory === true ? { mandatory: true } : {})
  }
}

/** Reject graphs the runner cannot execute safely (cycles, dup ids, parallel `as`). */
export function validateRunnable(nodes: PipelineNode[]): string | null {
  const ids = nodes.map((n) => n.id)
  if (new Set(ids).size !== ids.length) return 'Pipeline has duplicate node ids'
  if (!topoSort(nodes)) return 'Pipeline has a dependency cycle'
  if (parallelAsClashIds(nodes).size) {
    return 'Pipeline has parallel steps with the same output name (as)'
  }
  return null
}

export function sanitizePipelines(raw: unknown): Pipeline[] | null {
  if (!Array.isArray(raw)) return null
  return raw.flatMap((p) => {
    const pipe = sanitizePipeline(p)
    return pipe ? [pipe] : []
  })
}

/**
 * Find the pipeline an agent asked for. Accepts an exact id, a name
 * (case-insensitive), or an unambiguous partial name — agents rarely echo an
 * id back verbatim. Ambiguity is an error rather than a guess, so the caller
 * can say which candidates matched.
 */
export function resolvePipeline(
  pipelines: Pipeline[],
  query: string
): { ok: true; pipeline: Pipeline } | { ok: false; message: string; candidates: string[] } {
  const q = query.trim()
  if (!q) return { ok: false, message: 'Name or id required', candidates: [] }

  const byId = pipelines.find((p) => p.id === q)
  if (byId) return { ok: true, pipeline: byId }

  const lower = q.toLowerCase()
  const byName = pipelines.filter((p) => p.name.toLowerCase() === lower)
  if (byName.length === 1) return { ok: true, pipeline: byName[0] }

  const partial = pipelines.filter(
    (p) => p.name.toLowerCase().includes(lower) || p.id.toLowerCase().includes(lower)
  )
  if (partial.length === 1) return { ok: true, pipeline: partial[0] }
  if (partial.length > 1) {
    return {
      ok: false,
      message: `"${q}" matches more than one pipeline`,
      candidates: partial.map((p) => `${p.name} (${p.id})`)
    }
  }
  return {
    ok: false,
    message: `No pipeline matches "${q}"`,
    candidates: pipelines.map((p) => `${p.name} (${p.id})`)
  }
}
