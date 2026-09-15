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
    expect(
      stripControlMarkers('Need a choice.\nFAROL_QUESTIONS: [{"question":"Go?"}]\n')
    ).toBe('Need a choice.')
    expect(stripControlMarkers('Plan ready.\nFAROL_PLAN: finished\n')).toBe('Plan ready.')
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

  it('renders GFM-style tables with inline markdown and alignment', () => {
    const out = html([
      '| Stack | Contract | Fit |',
      '| :--- | :---: | ---: |',
      '| pstack | `pipelines.json` | **Strong** |'
    ].join('\n'))
    expect(out).toContain('class="bf-md-table-wrap"')
    expect(out).not.toContain('tabindex=')
    expect(out).toContain('<table class="bf-md-table">')
    expect(out).toContain('<th scope="col" style="text-align:left">Stack</th>')
    expect(out).toContain('<th scope="col" style="text-align:center">Contract</th>')
    expect(out).toContain('<th scope="col" style="text-align:right">Fit</th>')
    expect(out).toContain('<td style="text-align:right"><strong')
    expect(out).toContain('bf-md-code')
  })

  it('keeps pipes inside code and escaped pipes inside one table cell', () => {
    const out = html('| Example | Meaning |\n| --- | --- |\n| `a | b` | one \\| two |')
    expect(out.match(/<td/g)?.length).toBe(2)
    expect(out).toContain('>a | b<')
    expect(out).toContain('one | two')
  })

  it('keeps pipes inside multi-backtick code spans in one cell', () => {
    const out = html('| Example | Meaning |\n| --- | --- |\n| ``a | b`` | ok |')
    expect(out.match(/<td/g)?.length).toBe(2)
    expect(out).toContain('bf-md-code')
    expect(out).toContain('>a | b<')
    expect(out).not.toContain('``')
    expect(out).toContain('>ok<')
  })

  it('starts a table after adjacent paragraph text', () => {
    const out = html('Summary\n| A | B |\n| --- | --- |\n| one | two |')
    expect(out).toContain('Summary')
    expect(out).toContain('<table class="bf-md-table">')
  })

  it('renders tables without outer pipes', () => {
    const out = html('A | B\n--- | ---\none | two')
    expect(out).toContain('<table class="bf-md-table">')
    expect(out.match(/<td/g)?.length).toBe(2)
  })

  it('renders header-only tables and pads or truncates body cells', () => {
    const emptyBody = html('| A | B |\n| --- | --- |')
    expect(emptyBody).toContain('<table class="bf-md-table">')
    expect(emptyBody).not.toContain('<td')

    const padded = html('| A | B | C |\n| --- | --- | --- |\n| only |')
    expect(padded.match(/<td/g)?.length).toBe(3)
    expect(padded).toContain('>only<')

    const truncated = html('| A | B |\n| --- | --- |\n| one | two | three |')
    expect(truncated.match(/<td/g)?.length).toBe(2)
    expect(truncated).toContain('>one<')
    expect(truncated).toContain('>two<')
    expect(truncated).not.toContain('three')
  })

  it('does not treat mismatched header and delimiter columns as a table', () => {
    const out = html('| A | B |\n| --- |\n| one | two |')
    expect(out).not.toContain('<table')
    expect(out).toContain('| A | B |')
  })

  it('stops a table before headings, lists, and quotes that contain pipes', () => {
    const out = html([
      '| A | B |',
      '| --- | --- |',
      '| one | two |',
      '# Heading | details',
      '- item | details',
      '> quote | details'
    ].join('\n'))
    expect(out.match(/<tr/g)?.length).toBe(2)
    expect(out).toContain('Heading | details')
    expect(out).toContain('item | details')
    expect(out).toContain('quote | details')
  })

  it('absorbs indented block-like markers into paragraphs instead of hanging', () => {
    const out = html('Lead\n  ---\n  # Hi\n  - item\n  > q\n  ```\nTail')
    expect(out).toContain('Lead')
    expect(out).toContain('  ---')
    expect(out).toContain('  # Hi')
    expect(out).toContain('  - item')
    expect(out).toContain('  &gt; q')
    expect(out).toContain('Tail')
    expect(out).not.toContain('<hr')
    expect(out).not.toContain('<pre')
  })

  it('renders the chat regression table from agent output', () => {
    const out = html([
      '**Same thesis, different layer**',
      '',
      '| pstack | Farol today | Fit |',
      '|--------|------------------|-----|',
      '| Feature Map + control CLI as the contract of "done" | `.farol/pipelines.json` + runner as the contract of "done" | Same pattern, different subject |',
      '| Don\'t trust the model to re-run checks | `FAROL_PIPELINES` + "never run catalog cmds yourself" | Soft enforcement (prompt), not a sandbox |'
    ].join('\n'))
    expect(out).toContain('<table class="bf-md-table">')
    expect(out).toContain('<th scope="col" style="text-align:left">pstack</th>')
    expect(out).toContain('<th scope="col" style="text-align:left">Farol today</th>')
    expect(out).toContain('<th scope="col" style="text-align:left">Fit</th>')
    expect(out).toContain('>pstack<')
    expect(out).toContain('bf-md-code')
    expect(out).toContain('Same pattern, different subject')
    expect(out).not.toContain('|--------|')
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
