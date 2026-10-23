/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { ToolCard } from './cards'

afterEach(cleanup)

describe('ToolCard', () => {
  it('shows the name and the detail on one line, with the full detail as a tooltip', () => {
    render(<ToolCard tool={{ toolId: 't1', name: 'Read', detail: 'src/a.ts', state: 'done' }} tight={false} />)
    expect(screen.getByText('Read')).toBeTruthy()
    expect(screen.getByText('src/a.ts').getAttribute('title')).toBe('src/a.ts')
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('shows a spinner while running and no detail when there is none', () => {
    const { container } = render(<ToolCard tool={{ toolId: 't2', name: 'Bash', state: 'running' }} tight={false} />)
    expect(screen.getByText('Bash')).toBeTruthy()
    expect(container.querySelector('[title]')).toBeNull()
    expect(container.querySelector('svg')?.style.animation).toContain('bfspin')
  })
})
