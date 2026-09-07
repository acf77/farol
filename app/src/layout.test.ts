import { describe, expect, it } from 'vitest'
import {
  computeLayout,
  dragToSize,
  leaf,
  leaves,
  removeLeaf,
  setSize,
  splitLeaf,
  type PaneNode
} from './layout'

const ids = (n: PaneNode): string[] => leaves(n)

describe('pane layout', () => {
  it('fills the tab with a single pane', () => {
    const { panes, dividers } = computeLayout(leaf('a'))
    expect(panes).toEqual([{ id: 'a', x: 0, y: 0, w: 100, h: 100 }])
    expect(dividers).toHaveLength(0)
  })

  it('splits right into two half-width panes', () => {
    const root = splitLeaf(leaf('a'), 'a', 'row', 'b', 's1')
    const { panes, dividers } = computeLayout(root)
    expect(panes).toEqual([
      { id: 'a', x: 0, y: 0, w: 50, h: 100 },
      { id: 'b', x: 50, y: 0, w: 50, h: 100 }
    ])
    expect(dividers[0]).toMatchObject({ id: 's1', dir: 'row', x: 50 })
  })

  it('splits down into two half-height panes', () => {
    const root = splitLeaf(leaf('a'), 'a', 'col', 'b', 's1')
    const { panes } = computeLayout(root)
    expect(panes).toEqual([
      { id: 'a', x: 0, y: 0, w: 100, h: 50 },
      { id: 'b', x: 0, y: 50, w: 100, h: 50 }
    ])
  })

  it('splits only the targeted pane when nested', () => {
    let root = splitLeaf(leaf('a'), 'a', 'row', 'b', 's1')
    root = splitLeaf(root, 'b', 'col', 'c', 's2')
    expect(ids(root)).toEqual(['a', 'b', 'c'])
    const { panes } = computeLayout(root)
    expect(panes).toEqual([
      { id: 'a', x: 0, y: 0, w: 50, h: 100 },
      { id: 'b', x: 50, y: 0, w: 50, h: 50 },
      { id: 'c', x: 50, y: 50, w: 50, h: 50 }
    ])
  })

  it('gives the space back to the sibling when a pane closes', () => {
    let root = splitLeaf(leaf('a'), 'a', 'row', 'b', 's1')
    root = splitLeaf(root, 'b', 'col', 'c', 's2')
    const after = removeLeaf(root, 'b')
    expect(after).not.toBeNull()
    expect(ids(after as PaneNode)).toEqual(['a', 'c'])
    expect(computeLayout(after as PaneNode).panes).toEqual([
      { id: 'a', x: 0, y: 0, w: 50, h: 100 },
      { id: 'c', x: 50, y: 0, w: 50, h: 100 }
    ])
  })

  it('returns null once the last pane is removed', () => {
    expect(removeLeaf(leaf('a'), 'a')).toBeNull()
  })

  it('resizes one split without touching the others', () => {
    let root = splitLeaf(leaf('a'), 'a', 'row', 'b', 's1')
    root = splitLeaf(root, 'a', 'col', 'c', 's2')
    root = setSize(root, 's1', 70)
    const { panes } = computeLayout(root)
    expect(panes.find((p) => p.id === 'b')).toEqual({ id: 'b', x: 70, y: 0, w: 30, h: 100 })
    // The nested split kept its own 50/50.
    expect(panes.find((p) => p.id === 'c')).toEqual({ id: 'c', x: 0, y: 50, w: 70, h: 50 })
  })

  it('maps a drag position to a clamped split size', () => {
    const root = splitLeaf(leaf('a'), 'a', 'row', 'b', 's1')
    const [divider] = computeLayout(root).dividers
    expect(dragToSize(divider, 0.25)).toBe(25)
    expect(dragToSize(divider, 0.02)).toBe(15) // clamped low
    expect(dragToSize(divider, 0.99)).toBe(85) // clamped high
  })

  it('measures a drag inside a nested split, not the whole tab', () => {
    let root = splitLeaf(leaf('a'), 'a', 'row', 'b', 's1')
    root = splitLeaf(root, 'b', 'row', 'c', 's2')
    const nested = computeLayout(root).dividers.find((d) => d.id === 's2')!
    // s2 owns the right half, so the tab's 75% mark is its local midpoint.
    expect(dragToSize(nested, 0.75)).toBeCloseTo(50)
  })
})
