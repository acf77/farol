import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { createElement } from 'react'
import { MarkdownBody, stripControlMarkers, renderMarkdown } from './markdown'

function html(source: string): string {
  return renderToStaticMarkup(createElement(MarkdownBody, { text: source }))
}

describe('stripControlMarkers', () => {
  it('removes Farol harness lines', () => {
    expect(
      stripControlMarkers('Done.\nFAROL_PIPELINES: ["lint"]\n')
    ).toBe('Done.')
    expect(
      stripControlMarkers('Stopped.\nFAROL_BLOCKED: no access\n')
    ).toBe('Stopped.')
  })
})

describe('renderMarkdown', () => {
  it('renders headings, emphasis, and inline code', () => {
    const out = html('# Title\n\nHello **world** and `x`')
    expect(out).toContain('Title')
    expect(out).toContain('<strong')
    expect(out).toContain('world')
    expect(out).toContain('bf-md-code')
    expect(out).toContain('>x<')
  })

  it('renders fenced code blocks with a language label', () => {
    const out = html('```ts\nconst n = 1\n```')
    expect(out).toContain('<pre')
    expect(out).toContain('ts')
    expect(out).toContain('const n = 1')
  })

  it('renders lists and links', () => {
    const out = html('- one\n- two\n\n1. first\n\n[docs](https://example.com)')
    expect(out).toContain('•')
    expect(out).toContain('one')
    expect(out).toContain('1.')
    expect(out).toContain('href="https://example.com"')
    expect(out).toContain('docs')
  })

  it('drops non-http(s) markdown links', () => {
    const out = html('[x](javascript:alert(1)) and [y](file:///etc/passwd) and [ok](http://a.test)')
    expect(out).not.toContain('javascript:')
    expect(out).not.toContain('file:')
    expect(out).toContain('x')
    expect(out).toContain('y')
    expect(out).toContain('href="http://a.test"')
    expect(out.match(/href=/g)?.length).toBe(1)
  })

  it('hides harness markers from the rendered tree', () => {
    const nodes = renderMarkdown('All good\nFAROL_PIPELINES: []\n')
    const markup = renderToStaticMarkup(createElement('div', null, ...nodes))
    expect(markup).toContain('All good')
    expect(markup).not.toContain('FAROL_PIPELINES')
  })
})
