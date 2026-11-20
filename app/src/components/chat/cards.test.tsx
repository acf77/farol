/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { PipelineMsgCard, ToolCard } from './cards'

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

describe('PipelineMsgCard for a Git action', () => {
  const git = {
    pipelineId: 'git:status', pipelineName: 'Git status', status: 'passed' as const,
    startedAt: 1, tabId: 'git:t:1', git: { detail: '' }
  }
  const text = 'Git status done: Branch main: no remote.\n2 changed files:\n  modified: a.ts\n  added: b.ts'

  it('folds the file list and has no Logs button', () => {
    render(<PipelineMsgCard pc={git} text={text} onOpenPipeline={() => undefined} />)
    expect(screen.queryByText('Logs')).toBeNull()
    expect(screen.getByText('- branch main')).toBeTruthy()
    expect(screen.queryByText(/a\.ts/)).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: /Show 2 changed files/ }))

    expect(screen.getByText(/modified: a\.ts/)).toBeTruthy()
  })
})
