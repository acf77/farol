/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { ToolCard } from './cards'

afterEach(cleanup)

describe('ToolCard', () => {
  it('expands to show the full detail', () => {
    render(<ToolCard tool={{ toolId: 't1', name: 'Read', detail: 'src/a.ts', state: 'done' }} tight={false} />)
    const trigger = screen.getByRole('button')
    expect(trigger.getAttribute('aria-expanded')).toBe('false')
    expect(screen.getAllByText('src/a.ts')).toHaveLength(1)

    fireEvent.click(trigger)

    expect(trigger.getAttribute('aria-expanded')).toBe('true')
    expect(screen.getAllByText('src/a.ts')).toHaveLength(2)
  })

  it('is a plain line without detail', () => {
    render(<ToolCard tool={{ toolId: 't2', name: 'Bash', state: 'running' }} tight={false} />)
    expect(screen.queryByRole('button')).toBeNull()
    expect(screen.getByText('Bash').className).toBe('bf-shimmer')
  })
})
