import { expect, it } from 'vitest'
import { secureBrowserContents } from './browser-security'

it('blocks non-HTTP navigation and redirects, and denies permissions', () => {
  const handlers: Record<string, (...args: never[]) => unknown> = {}
  const session = {
    setPermissionRequestHandler: (handler: (...args: never[]) => unknown) => { handlers.request = handler },
    setPermissionCheckHandler: (handler: (...args: never[]) => unknown) => { handlers.check = handler }
  }
  const loaded: string[] = []
  const wc = {
    session,
    on: (name: string, handler: (...args: never[]) => unknown) => { handlers[name] = handler },
    setWindowOpenHandler: (handler: (...args: never[]) => unknown) => { handlers.open = handler },
    loadURL: async (url: string) => { loaded.push(url) }
  }
  secureBrowserContents(wc as unknown as Electron.WebContents)
  for (const name of ['will-navigate', 'will-redirect']) {
    for (const [url, blocked] of [['https://example.com', false], ['mailto:user@example.com', true], ['tel:123', true]] as const) {
      let prevented = false
      handlers[name]({ url, preventDefault: () => { prevented = true } } as never)
      expect(prevented).toBe(blocked)
    }
  }
  handlers.open({ url: 'mailto:user@example.com' } as never)
  handlers.open({ url: 'https://example.com' } as never)
  expect(loaded).toEqual(['https://example.com'])
  let granted = true
  handlers.request(null as never, 'media' as never, ((value: boolean) => { granted = value }) as never)
  expect(granted).toBe(false)
  expect(handlers.check()).toBe(false)
})
