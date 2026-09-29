import { describe, expect, it } from 'vitest'
import { computeLayout } from './layout'
import {
  closeSurface,
  defaultLayout,
  focusSurface,
  parseLayout,
  resizeSplit,
  revealSurface,
  showView,
  splitFocused,
  splitPartner,
  surfacesOf,
  viewOf
} from './workspace-layout'

describe('workspace layout', () => {
  it('matches the toolbar presets and reports custom arrangements as null', () => {
    const chat = defaultLayout()
    expect(viewOf(chat.root)).toBe('chat')
    expect(viewOf(showView(chat, 'split').root)).toBe('split')
    expect(viewOf(splitFocused(chat, 'col', 'code').root)).toBeNull()
  })

  it('keeps a dragged preset highlighted', () => {
    const split = showView(defaultLayout(), 'split')
    expect(viewOf(resizeSplit(split, 'w1', 70).root)).toBe('split')
  })

  it('splits any focused surface with any other, in either direction', () => {
    const code = showView(defaultLayout(), 'code')
    const withTerminal = splitFocused(code, 'col', 'terminal')
    expect(withTerminal.focus).toBe('terminal')
    expect(computeLayout(withTerminal.root).panes).toEqual([
      { id: 'code', x: 0, y: 0, w: 100, h: 50 },
      { id: 'terminal', x: 0, y: 50, w: 100, h: 50 }
    ])
  })

  it('moves a surface that is already showing instead of duplicating it', () => {
    const split = showView(defaultLayout(), 'split')
    const moved = splitFocused({ ...split, focus: 'chat' }, 'col', 'terminal')
    expect(surfacesOf(moved.root).sort()).toEqual(['chat', 'terminal'])
    expect(computeLayout(moved.root).panes).toEqual([
      { id: 'chat', x: 0, y: 0, w: 100, h: 50 },
      { id: 'terminal', x: 0, y: 50, w: 100, h: 50 }
    ])
  })

  it('gives every split a unique id across repeated splits and moves', () => {
    let l = defaultLayout()
    l = splitFocused(l, 'row', 'terminal')
    l = splitFocused(l, 'col', 'code')
    l = splitFocused({ ...l, focus: 'chat' }, 'col', 'terminal')
    const ids = computeLayout(l.root).dividers.map((d) => d.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(surfacesOf(l.root).sort()).toEqual(['chat', 'code', 'terminal'])
  })

  it('reveals a hidden surface beside the current layout and focuses it', () => {
    const l = revealSurface(showView(defaultLayout(), 'code'), 'terminal')
    expect(surfacesOf(l.root)).toEqual(['code', 'terminal'])
    expect(l.focus).toBe('terminal')
    const again = revealSurface(l, 'terminal')
    expect(again).toBe(l)
  })

  it('closes a surface into its sibling but never the last one', () => {
    const split = showView(defaultLayout(), 'split')
    const closed = closeSurface({ ...split, focus: 'terminal' }, 'terminal')
    expect(surfacesOf(closed.root)).toEqual(['chat'])
    expect(closed.focus).toBe('chat')
    expect(closeSurface(closed, 'chat')).toBe(closed)
  })

  it('prefers the terminal as a split partner, then chat, then code', () => {
    expect(splitPartner(['code'])).toBe('terminal')
    expect(splitPartner(['chat', 'terminal'])).toBe('code')
    expect(splitPartner(['terminal', 'code'])).toBe('chat')
    expect(splitPartner(['chat', 'code', 'terminal'])).toBeUndefined()
  })

  it('only focuses surfaces that are showing', () => {
    const l = defaultLayout()
    expect(focusSurface(l, 'code')).toBe(l)
  })

  it('round-trips a saved layout and rejects damaged ones', () => {
    const l = splitFocused(defaultLayout(), 'col', 'code')
    expect(parseLayout(JSON.parse(JSON.stringify(l)))).toEqual(l)
    expect(parseLayout(null)).toBeNull()
    expect(parseLayout({ root: { t: 'leaf', id: 'notes' }, focus: 'chat' })).toBeNull()
    const twice = { t: 'split', id: 'w1', dir: 'row', size: 50, a: { t: 'leaf', id: 'chat' }, b: { t: 'leaf', id: 'chat' } }
    expect(parseLayout({ root: twice, focus: 'chat' })).toBeNull()
  })

  it('clamps saved sizes and repairs a stale focus', () => {
    const raw = {
      root: { t: 'split', id: 'w1', dir: 'row', size: 500, a: { t: 'leaf', id: 'chat' }, b: { t: 'leaf', id: 'code' } },
      focus: 'terminal'
    }
    const parsed = parseLayout(raw)
    expect(parsed?.focus).toBe('chat')
    expect(parsed?.root).toMatchObject({ size: 85 })
  })
})
