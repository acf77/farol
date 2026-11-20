import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { GIT_REQUESTS, GitBar } from './GitBar'

describe('GitBar', () => {
  it('sends the prompt of the button that was pressed', () => {
    const onRequest = vi.fn()
    render(<GitBar disabled={false} onRequest={onRequest} />)
    fireEvent.click(screen.getByText('Push'))
    expect(onRequest).toHaveBeenCalledWith(GIT_REQUESTS[1].prompt)
  })

  it('sends nothing while disabled', () => {
    const onRequest = vi.fn()
    render(<GitBar disabled onRequest={onRequest} />)
    fireEvent.click(screen.getByText('Commit'))
    expect(onRequest).not.toHaveBeenCalled()
  })
})
