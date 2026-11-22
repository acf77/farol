/**
 * @vitest-environment jsdom
 */
import { renderToString } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import CloseProjectDialog from './CloseProjectDialog'

function render(props: Partial<Parameters<typeof CloseProjectDialog>[0]> = {}): string {
  return renderToString(
    <CloseProjectDialog
      branch="feat-x"
      path="/work/repo-feat-x"
      canDelete
      busy={false}
      onCancel={vi.fn()}
      onClose={vi.fn()}
      onDelete={vi.fn()}
      {...props}
    />
  )
}

describe('CloseProjectDialog', () => {
  it('offers cancel, close and delete in a modal alert', () => {
    const html = render()
    expect(html).toContain('role="alertdialog"')
    expect(html).toContain('feat-x')
    expect(html).toContain('/work/repo-feat-x')
    for (const label of ['Cancel', 'Close', 'Delete']) expect(html).toContain(`>${label}</button>`)
  })

  it('disables delete for the main checkout', () => {
    const html = render({ canDelete: false })
    expect(html).toContain('The main checkout cannot be deleted.')
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Delete<\/button>/)
  })

  it('warns when an agent is working', () => {
    expect(render({ busy: true })).toContain('An agent is working here.')
    expect(render()).not.toContain('An agent is working here.')
  })
})
