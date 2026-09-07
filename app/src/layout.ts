/**
 * Pane layout for a terminal tab: a binary tree of splits with leaves for
 * panes, the same shape a tiling terminal uses. Every function here is pure,
 * so the tree can live in React state and the geometry can be unit-tested.
 *
 * Sizes and rects are percentages of the tab's terminal area.
 */

export type PaneNode =
  | { t: 'leaf'; id: string }
  | { t: 'split'; id: string; dir: 'row' | 'col'; size: number; a: PaneNode; b: PaneNode }

export interface Rect {
  id: string
  x: number
  y: number
  w: number
  h: number
}

export interface Divider {
  id: string
  dir: 'row' | 'col'
  /** Position of the divider itself. */
  x: number
  y: number
  w: number
  h: number
  /** The split's own box, used to turn a drag into a percentage. */
  rx: number
  ry: number
  rw: number
  rh: number
}

export const MIN_SPLIT = 15
export const MAX_SPLIT = 85

export function leaf(id: string): PaneNode {
  return { t: 'leaf', id }
}

export function leaves(n: PaneNode, out: string[] = []): string[] {
  if (n.t === 'leaf') out.push(n.id)
  else {
    leaves(n.a, out)
    leaves(n.b, out)
  }
  return out
}

/** Replace `targetId` with a split holding it and a new pane beside it. */
export function splitLeaf(
  root: PaneNode,
  targetId: string,
  dir: 'row' | 'col',
  newId: string,
  splitId: string
): PaneNode {
  const rep = (n: PaneNode): PaneNode => {
    if (n.t === 'leaf') {
      return n.id === targetId
        ? { t: 'split', id: splitId, dir, size: 50, a: n, b: leaf(newId) }
        : n
    }
    return { ...n, a: rep(n.a), b: rep(n.b) }
  }
  return rep(root)
}

/** Drop a pane; its sibling takes over the space. Returns null if nothing is left. */
export function removeLeaf(root: PaneNode, id: string): PaneNode | null {
  const rem = (n: PaneNode): PaneNode | null => {
    if (n.t === 'leaf') return n.id === id ? null : n
    const a = rem(n.a)
    const b = rem(n.b)
    if (!a) return b
    if (!b) return a
    return { ...n, a, b }
  }
  return rem(root)
}

export function setSize(root: PaneNode, nodeId: string, size: number): PaneNode {
  const upd = (n: PaneNode): PaneNode => {
    if (n.t === 'leaf') return n
    if (n.id === nodeId) return { ...n, size }
    return { ...n, a: upd(n.a), b: upd(n.b) }
  }
  return upd(root)
}

export function computeLayout(root: PaneNode): { panes: Rect[]; dividers: Divider[] } {
  const panes: Rect[] = []
  const dividers: Divider[] = []

  const walk = (n: PaneNode, x: number, y: number, w: number, h: number): void => {
    if (n.t === 'leaf') {
      panes.push({ id: n.id, x, y, w, h })
      return
    }
    if (n.dir === 'row') {
      const wa = (w * n.size) / 100
      walk(n.a, x, y, wa, h)
      walk(n.b, x + wa, y, w - wa, h)
      dividers.push({ id: n.id, dir: 'row', x: x + wa, y, w: 0, h, rx: x, ry: y, rw: w, rh: h })
    } else {
      const ha = (h * n.size) / 100
      walk(n.a, x, y, w, ha)
      walk(n.b, x, y + ha, w, h - ha)
      dividers.push({ id: n.id, dir: 'col', x, y: y + ha, w, h: 0, rx: x, ry: y, rw: w, rh: h })
    }
  }

  walk(root, 0, 0, 100, 100)
  return { panes, dividers }
}

/** Turn a pointer position inside the pane area into a split percentage. */
export function dragToSize(d: Divider, fraction: number): number {
  const local = d.dir === 'row' ? (fraction * 100 - d.rx) / d.rw : (fraction * 100 - d.ry) / d.rh
  return Math.min(MAX_SPLIT, Math.max(MIN_SPLIT, local * 100))
}
