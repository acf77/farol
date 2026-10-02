/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { CustomPrompt, CustomPromptSet } from '@shared/custom-prompts'
import { CustomPromptsSection } from './CustomPromptsSection'

function prompt(id: string, body: string, active = false): CustomPrompt {
  return { id, name: id, body, active, updatedAt: 1 }
}

/** In-memory stand-in for the main-process store. */
function fakePrompts(initial: Partial<CustomPromptSet> = {}) {
  let state: CustomPromptSet = {
    global: [],
    project: [],
    activeProjectIds: [],
    projectRoot: '/repo',
    ...initial
  }
  const snap = () => Promise.resolve(structuredClone(state))
  return {
    get state() {
      return state
    },
    load: vi.fn(() => snap()),
    saveGlobal: vi.fn((_p: string | null, list: CustomPrompt[]) => {
      state = { ...state, global: list }
      return snap()
    }),
    saveProject: vi.fn((_p: string, list: CustomPrompt[]) => {
      state = { ...state, project: list.map((p) => ({ ...p, active: false })) }
      return snap()
    }),
    setProjectActive: vi.fn((_p: string, ids: string[]) => {
      state = { ...state, activeProjectIds: ids }
      return snap()
    })
  }
}

let api: ReturnType<typeof fakePrompts>

function mount(initial: Partial<CustomPromptSet> = {}, projectPath: string | null = '/repo') {
  api = fakePrompts(initial)
  ;(window as unknown as { farol: unknown }).farol = { prompts: api }
  return render(<CustomPromptsSection projectPath={projectPath} projectName="repo" />)
}

beforeEach(() => {
  vi.stubGlobal('crypto', { randomUUID: () => 'new-id' })
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('CustomPromptsSection', () => {
  it('lists global and project prompts with their on state', async () => {
    mount({ global: [prompt('terse', 'Be terse.', true)], project: [prompt('tests', 'Use vitest.')] })
    const terse = await screen.findByRole('switch', { name: 'terse' })
    expect(terse.getAttribute('aria-checked')).toBe('true')
    expect(screen.getByRole('switch', { name: 'tests' }).getAttribute('aria-checked')).toBe('false')
    expect(api.load).toHaveBeenCalledWith('/repo')
  })

  it('creates a global prompt that starts on', async () => {
    mount()
    const [newGlobal] = await screen.findAllByRole('button', { name: 'New prompt' })
    fireEvent.click(newGlobal)
    fireEvent.change(screen.getByLabelText('Prompt name'), { target: { value: 'Terse' } })
    fireEvent.change(screen.getByLabelText('Prompt text'), { target: { value: 'Answer briefly.' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(api.saveGlobal).toHaveBeenCalled())
    expect(api.state.global).toEqual([
      expect.objectContaining({ id: 'new-id', name: 'Terse', body: 'Answer briefly.', active: true })
    ])
    expect((await screen.findByRole('switch', { name: 'Terse' })).getAttribute('aria-checked')).toBe('true')
  })

  it('creates a project prompt and switches it on for this machine', async () => {
    mount()
    const buttons = await screen.findAllByRole('button', { name: 'New prompt' })
    fireEvent.click(buttons[1])
    fireEvent.change(screen.getByLabelText('Prompt text'), { target: { value: 'Run vitest.' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(api.setProjectActive).toHaveBeenCalledWith('/repo', ['new-id']))
    expect(api.saveProject).toHaveBeenCalledWith('/repo', [expect.objectContaining({ id: 'new-id' })])
    expect((await screen.findByRole('switch', { name: 'Untitled prompt' })).getAttribute('aria-checked')).toBe('true')
  })

  it('toggles a global prompt by saving the global list', async () => {
    mount({ global: [prompt('terse', 'Be terse.', true)] })
    fireEvent.click(await screen.findByRole('switch', { name: 'terse' }))
    await waitFor(() => expect(api.saveGlobal).toHaveBeenCalledWith('/repo', [expect.objectContaining({ active: false })]))
  })

  it('toggles a project prompt through per-machine activation only', async () => {
    mount({ project: [prompt('tests', 'Use vitest.')] })
    fireEvent.click(await screen.findByRole('switch', { name: 'tests' }))
    await waitFor(() => expect(api.setProjectActive).toHaveBeenCalledWith('/repo', ['tests']))
    expect(api.saveProject).not.toHaveBeenCalled()
  })

  it('edits a prompt in place and keeps its on state', async () => {
    mount({ global: [prompt('terse', 'Be terse.', true)] })
    fireEvent.click(await screen.findByRole('button', { name: 'Edit' }))
    fireEvent.change(screen.getByLabelText('Prompt text'), { target: { value: 'Be very terse.' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() =>
      expect(api.state.global).toEqual([expect.objectContaining({ id: 'terse', body: 'Be very terse.', active: true })])
    )
  })

  it('asks before deleting a prompt', async () => {
    mount({ global: [prompt('terse', 'Be terse.')] })
    fireEvent.click(await screen.findByRole('button', { name: 'Delete terse' }))
    expect(api.saveGlobal).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
    await waitFor(() => expect(api.state.global).toEqual([]))
  })

  it('greys out project prompts with no project open', async () => {
    mount({ projectRoot: null }, null)
    expect(await screen.findByText('Open a project to add its prompts.')).toBeTruthy()
    const [, projectNew] = screen.getAllByRole('button', { name: 'New prompt' })
    expect((projectNew as HTMLButtonElement).disabled).toBe(true)
  })

  it('warns when the active prompts get long', async () => {
    mount({ global: [prompt('long', 'x'.repeat(4100), true)] })
    const note = await screen.findByText(/characters sent with every turn — consider trimming/)
    expect(within(note.parentElement!).getByText(/1 on/)).toBeTruthy()
  })

  it('shows a save error and keeps the editor open', async () => {
    mount()
    api.saveGlobal.mockRejectedValueOnce(new Error('Could not read custom-prompts.json'))
    const [newGlobal] = await screen.findAllByRole('button', { name: 'New prompt' })
    fireEvent.click(newGlobal)
    fireEvent.change(screen.getByLabelText('Prompt text'), { target: { value: 'x' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(await screen.findByText('Could not read custom-prompts.json')).toBeTruthy()
    expect(screen.getByLabelText('Prompt text')).toBeTruthy()
  })
})
