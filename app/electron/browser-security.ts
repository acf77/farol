import { isHttpUrl } from '../shared/browser'

/** Allow only HTTP destinations and deny permissions for browser pages. */
export function secureBrowserContents(wc: Electron.WebContents): void {
  wc.session.setPermissionRequestHandler((_wc, _permission, done) => done(false))
  wc.session.setPermissionCheckHandler(() => false)
  wc.setWindowOpenHandler(({ url }) => {
    if (isHttpUrl(url)) void wc.loadURL(url).catch(() => {})
    return { action: 'deny' }
  })
  const guard = (event: Electron.Event & { url: string }): void => {
    if (!isHttpUrl(event.url)) event.preventDefault()
  }
  wc.on('will-navigate', guard)
  wc.on('will-redirect', guard)
}
