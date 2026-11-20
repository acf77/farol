import { createHash } from 'crypto'
import { WebContentsView, type BrowserWindow } from 'electron'
import { normalizeBrowserUrl, type BrowserBounds, type BrowserState } from '../shared/browser'
import { secureBrowserContents } from './browser-security'

const MAX_VIEWS = 16

/**
 * The Browser panel's pages. One sandboxed view per checkout, each in its own in-memory session,
 * so cookies and storage never cross checkouts. A page gets no preload and so no Farol API.
 * The renderer only names the checkout, a typed URL, and where the view sits in the window.
 */
export class BrowserManager {
  private readonly views = new Map<string, WebContentsView>()
  private readonly pending = new Map<string, string>()
  /** Removes the listeners a view put on its session. */
  private readonly detach = new Map<string, () => void>()
  private readonly watched = new WeakSet<BrowserWindow>()

  constructor(
    private readonly getWindow: () => BrowserWindow | null,
    private readonly emit: (checkout: string, state: BrowserState) => void
  ) {}

  /** Shows this checkout's view at `bounds`, making it on first use. */
  show(checkout: string, bounds: BrowserBounds): void {
    const win = this.getWindow()
    if (!win || win.isDestroyed()) return
    for (const [key, other] of this.views) if (key !== checkout) other.setVisible(false)
    if (!this.views.has(checkout) && this.views.size >= MAX_VIEWS) return
    this.watch(win)
    const view = this.views.get(checkout) ?? this.create(checkout)
    win.contentView.addChildView(view) // Also raises an existing view to the top.
    view.setVisible(true)
    const pending = this.pending.get(checkout)
    if (pending) {
      this.pending.delete(checkout)
      this.navigate(checkout, pending)
    }
    const zoom = win.webContents.getZoomFactor()
    view.setBounds({
      x: Math.round(bounds.x * zoom),
      y: Math.round(bounds.y * zoom),
      width: Math.round(bounds.width * zoom),
      height: Math.round(bounds.height * zoom)
    })
  }

  hide(checkout: string): void {
    this.views.get(checkout)?.setVisible(false)
  }

  navigate(checkout: string, input: unknown): boolean {
    const url = normalizeBrowserUrl(input)
    const view = this.views.get(checkout)
    if (!url) return false
    if (!view) {
      this.pending.set(checkout, url)
      return true
    }
    void view.webContents.loadURL(url).catch(() => {}) // Failures show through did-fail-load.
    return true
  }

  back(checkout: string): void {
    const history = this.views.get(checkout)?.webContents.navigationHistory
    if (history?.canGoBack()) history.goBack()
  }

  forward(checkout: string): void {
    const history = this.views.get(checkout)?.webContents.navigationHistory
    if (history?.canGoForward()) history.goForward()
  }

  reload(checkout: string): void {
    const wc = this.views.get(checkout)?.webContents
    if (!wc) return
    if (wc.isLoading()) wc.stop()
    else wc.reload()
  }

  state(checkout: string): BrowserState | null {
    const wc = this.views.get(checkout)?.webContents
    return wc && !wc.isDestroyed() ? this.read(wc) : null
  }

  /** Closes one checkout's page and drops its view. */
  dispose(checkout: string): void {
    this.pending.delete(checkout)
    const view = this.views.get(checkout)
    if (!view) return
    this.views.delete(checkout)
    this.detach.get(checkout)?.()
    this.detach.delete(checkout)
    const win = this.getWindow()
    if (win && !win.isDestroyed()) win.contentView.removeChildView(view)
    if (!view.webContents.isDestroyed()) view.webContents.close()
  }

  disposeAll(): void {
    for (const checkout of this.views.keys()) this.dispose(checkout)
  }

  private read(wc: Electron.WebContents): BrowserState {
    return {
      url: wc.getURL(),
      title: wc.getTitle(),
      loading: wc.isLoading(),
      canGoBack: wc.navigationHistory.canGoBack(),
      canGoForward: wc.navigationHistory.canGoForward()
    }
  }

  /** Closing a window closes its pages, once per window however many pages came and went. */
  private watch(win: BrowserWindow): void {
    if (this.watched.has(win)) return
    this.watched.add(win)
    win.once('closed', () => this.disposeAll())
  }

  private create(checkout: string): WebContentsView {
    const view = new WebContentsView({
      webPreferences: {
        partition: `farol-browser-${createHash('sha1').update(checkout).digest('hex').slice(0, 16)}`,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true
      }
    })
    view.setBackgroundColor('#181817')
    const wc = view.webContents
    // A page asks for nothing: no camera, location, notifications, or downloads.
    secureBrowserContents(wc)
    const refuseDownload = (event: Electron.Event): void => event.preventDefault()
    wc.session.on('will-download', refuseDownload)
    this.detach.set(checkout, () => wc.session.removeListener('will-download', refuseDownload))
    const push = (): void => {
      if (!wc.isDestroyed()) this.emit(checkout, this.read(wc))
    }
    for (const name of [
      'did-start-loading',
      'did-stop-loading',
      'did-navigate',
      'did-navigate-in-page',
      'page-title-updated'
    ] as const) {
      wc.on(name, push)
    }
    this.views.set(checkout, view)
    return view
  }
}
