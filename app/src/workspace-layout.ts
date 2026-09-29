import { leaf, leaves, MAX_SPLIT, MIN_SPLIT, removeLeaf, setSize, splitLeaf, type PaneNode } from './layout'
import type { View } from './types'

/**
 * The workspace's own split tree. Leaves are the three surfaces, each shown at
 * most once per project; splits reuse the terminal tab's {@link PaneNode}
 * geometry, so the same dividers and drag maths serve both.
 */
export type Surface = 'chat' | 'code' | 'terminal'

export const SURFACES: readonly Surface[] = ['chat', 'code', 'terminal']

export const SURFACE_LABEL: Record<Surface, string> = { chat: 'Chat', code: 'Code', terminal: 'Terminal' }

export interface WorkspaceLayout {
  root: PaneNode
  /** The surface that split and close act on. Always a leaf of `root`. */
  focus: Surface
}

const PRESETS: Record<View, PaneNode> = {
  chat: leaf('chat'),
  code: leaf('code'),
  terminal: leaf('terminal'),
  split: { t: 'split', id: 'w1', dir: 'row', size: 50, a: leaf('chat'), b: leaf('terminal') }
}

const isSurface = (v: unknown): v is Surface => SURFACES.includes(v as Surface)

export const surfacesOf = (root: PaneNode): Surface[] => leaves(root) as Surface[]

/** The surface a shortcut split brings in: terminal first, since chat + terminal is the usual pair. */
export const splitPartner = (showing: Surface[]): Surface | undefined =>
  (['terminal', 'chat', 'code'] as const).find((s) => !showing.includes(s))

/** Split ids only need to be unique within one tree. */
function nextSplitId(root: PaneNode): string {
  const maxOf = (n: PaneNode): number =>
    n.t === 'leaf' ? 0 : Math.max(Number(n.id.slice(1)) || 0, maxOf(n.a), maxOf(n.b))
  return `w${maxOf(root) + 1}`
}

const shape = (n: PaneNode): string =>
  n.t === 'leaf' ? n.id : `${n.dir}(${shape(n.a)},${shape(n.b)})`

/** The toolbar preset this tree matches, ignoring divider positions; null for a custom arrangement. */
export function viewOf(root: PaneNode): View | null {
  const s = shape(root)
  return (Object.keys(PRESETS) as View[]).find((v) => shape(PRESETS[v]) === s) ?? null
}

export function showView(layout: WorkspaceLayout, view: View): WorkspaceLayout {
  const root = PRESETS[view]
  const surfaces = surfacesOf(root)
  return { root, focus: surfaces.includes(layout.focus) ? layout.focus : surfaces[0] }
}

/** Put a surface on screen beside whatever is showing, and focus it. */
export function revealSurface(layout: WorkspaceLayout, surface: Surface): WorkspaceLayout {
  if (surfacesOf(layout.root).includes(surface)) {
    return layout.focus === surface ? layout : { ...layout, focus: surface }
  }
  const root: PaneNode = {
    t: 'split',
    id: nextSplitId(layout.root),
    dir: 'row',
    size: 50,
    a: layout.root,
    b: leaf(surface)
  }
  return { root, focus: surface }
}

/** Split the focused surface, putting `surface` beside it — moved there if it was already elsewhere. */
export function splitFocused(layout: WorkspaceLayout, dir: 'row' | 'col', surface: Surface): WorkspaceLayout {
  if (surface === layout.focus) return layout
  const base = removeLeaf(layout.root, surface) ?? layout.root
  return { root: splitLeaf(base, layout.focus, dir, surface, nextSplitId(base)), focus: surface }
}

/** Close a surface; its sibling takes the space. The last surface cannot be closed. */
export function closeSurface(layout: WorkspaceLayout, surface: Surface): WorkspaceLayout {
  const root = surfacesOf(layout.root).length > 1 ? removeLeaf(layout.root, surface) : null
  if (!root) return layout
  return { root, focus: layout.focus === surface ? surfacesOf(root)[0] : layout.focus }
}

export const resizeSplit = (layout: WorkspaceLayout, nodeId: string, size: number): WorkspaceLayout => ({
  ...layout,
  root: setSize(layout.root, nodeId, size)
})

export function focusSurface(layout: WorkspaceLayout, surface: Surface): WorkspaceLayout {
  return layout.focus === surface || !surfacesOf(layout.root).includes(surface)
    ? layout
    : { ...layout, focus: surface }
}

function parseNode(raw: unknown): PaneNode | null {
  if (!raw || typeof raw !== 'object') return null
  const n = raw as Record<string, unknown>
  if (n.t === 'leaf') return isSurface(n.id) ? leaf(n.id) : null
  if (n.t !== 'split' || typeof n.id !== 'string' || (n.dir !== 'row' && n.dir !== 'col')) return null
  const a = parseNode(n.a)
  const b = parseNode(n.b)
  if (!a || !b || typeof n.size !== 'number' || !Number.isFinite(n.size)) return null
  return { t: 'split', id: n.id, dir: n.dir, size: Math.min(MAX_SPLIT, Math.max(MIN_SPLIT, n.size)), a, b }
}

/** Rebuild a saved layout, or null when it is malformed or shows a surface twice. */
export function parseLayout(raw: unknown): WorkspaceLayout | null {
  if (!raw || typeof raw !== 'object') return null
  const { root: rawRoot, focus } = raw as Record<string, unknown>
  const root = parseNode(rawRoot)
  if (!root) return null
  const surfaces = surfacesOf(root)
  if (new Set(surfaces).size !== surfaces.length) return null
  return { root, focus: isSurface(focus) && surfaces.includes(focus) ? focus : surfaces[0] }
}

export const defaultLayout = (): WorkspaceLayout => ({ root: PRESETS.chat, focus: 'chat' })
