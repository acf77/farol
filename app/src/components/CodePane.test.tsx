/**
 * @vitest-environment jsdom
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import CodePane from './CodePane'
import type { CodeTab } from '../hooks/useCodeWorkspace'

const noop = {
  onOpen: vi.fn(),
  onSelect: vi.fn(),
  onChange: vi.fn(),
  onClose: vi.fn(),
  onSave: vi.fn(),
  onRevert: vi.fn(),
  onDiscard: vi.fn(),
  onOverwrite: vi.fn(),
  onCancelNotice: vi.fn()
}

function renderPane(props: Partial<Parameters<typeof CodePane>[0]> = {}): string {
  return renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <CodePane
        projectPath="/Users/dev/repo/alpha"
        tabs={[]}
        activePath={null}
        active={null}
        notice={null}
        {...noop}
        {...props}
      />
    </QueryClientProvider>
  )
}

function makeTab(overrides: Partial<CodeTab> = {}): CodeTab {
  return {
    path: 'src/a.ts',
    content: 'one',
    original: 'one',
    mtimeMs: 1,
    lineEnding: 'lf',
    ...overrides
  }
}

describe('CodePane', () => {
  it('shows the file tree and empty editor state', () => {
    const html = renderPane()
    expect(html).toContain('aria-label="Project files"')
    expect(html).toContain('alpha')
    expect(html).toContain('Open a file from the tree or ⌘K.')
    expect(html).toContain('No file open')
    expect(html).toContain('Saved')
    expect(html).toContain('disabled=""')
  })

  it('lists open tabs with a dirty marker and close control', () => {
    const dirty = makeTab({ content: 'two' })
    const html = renderPane({ tabs: [dirty], activePath: 'src/a.ts', active: dirty })
    expect(html).toContain('role="tablist"')
    expect(html).toContain('aria-selected="true"')
    expect(html).toContain('a.ts')
    expect(html).toContain('aria-label="Unsaved"')
    expect(html).toContain('aria-label="Close a.ts"')
    expect(html).toContain('Unsaved')
    expect(html).not.toContain('disabled=""')
  })

  it('reports CRLF line endings for the active file', () => {
    const crlf = makeTab({ lineEnding: 'crlf' })
    const html = renderPane({ tabs: [crlf], activePath: 'src/a.ts', active: crlf })
    expect(html).toContain('CRLF')
  })

  it('asks for confirmation before discarding a dirty close', () => {
    const html = renderPane({ notice: { kind: 'dirty-close', path: 'src/a.ts' } })
    expect(html).toContain('Discard unsaved changes?')
    expect(html).toContain('Discard')
  })

  it('offers overwrite on an mtime conflict', () => {
    const html = renderPane({ notice: { kind: 'conflict', path: 'src/a.ts' } })
    expect(html).toContain('File changed on disk. Overwrite?')
    expect(html).toContain('Overwrite')
  })

  it('shows read and write errors with a dismiss action', () => {
    const html = renderPane({ notice: { kind: 'error', text: 'File is larger than 2MB.' } })
    expect(html).toContain('File is larger than 2MB.')
    expect(html).toContain('Dismiss')
  })
})
