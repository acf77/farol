import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { isMermaidLang, MermaidDiagram, renderMermaidSvg } from './mermaid-diagram'

const render = vi.fn(async (_id: string, source: string) => ({
  svg: `<svg data-diagram="${source.includes('A-->B') ? 'ok' : 'other'}"></svg>`
}))
const initialize = vi.fn()

vi.mock('mermaid', () => ({
  default: { initialize, render }
}))

describe('isMermaidLang', () => {
  it('accepts mermaid fences only', () => {
    expect(isMermaidLang('mermaid')).toBe(true)
    expect(isMermaidLang('MERMAID')).toBe(true)
    expect(isMermaidLang('ts')).toBe(false)
    expect(isMermaidLang(undefined)).toBe(false)
  })
})

describe('renderMermaidSvg', () => {
  beforeEach(() => {
    render.mockClear()
  })

  it('renders with a strict dark theme', async () => {
    const svg = await renderMermaidSvg('flowchart TD\nA-->B', 't1')
    expect(svg).toContain('data-diagram="ok"')
    expect(initialize).toHaveBeenCalledWith(
      expect.objectContaining({
        startOnLoad: false,
        securityLevel: 'strict',
        htmlLabels: false,
        theme: 'dark'
      })
    )
  })

  it('surfaces mermaid render failures', async () => {
    render.mockRejectedValueOnce(new Error('bad diagram'))
    await expect(renderMermaidSvg('not a diagram', 't2')).rejects.toThrow('bad diagram')
  })
})

describe('MermaidDiagram', () => {
  it('falls back to the mermaid source before a browser render', () => {
    const html = renderToStaticMarkup(
      createElement(MermaidDiagram, { source: 'flowchart TD\nA-->B' })
    )
    expect(html).toContain('bf-md-mermaid')
    expect(html).toContain('flowchart TD')
    expect(html).toContain('A--&gt;B')
    expect(html).not.toContain('data-diagram')
  })
})
