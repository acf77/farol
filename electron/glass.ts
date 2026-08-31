import { createRequire } from 'node:module'
import type { BrowserWindow } from 'electron'

/**
 * Native macOS 26+ Liquid Glass behind the web contents. Falls back to a solid
 * window when the addon is missing or the OS is older than Tahoe.
 */

type LiquidGlass = {
  isGlassSupported(): boolean
  addView(handle: Buffer, options?: { cornerRadius?: number; tintColor?: string; opaque?: boolean }): number
  unstable_setVariant(id: number, variant: number): void
  GlassMaterialVariant: { sidebar: number; regular: number }
}

const require = createRequire(import.meta.url)
let mod: LiquidGlass | null | undefined

function load(): LiquidGlass | null {
  if (mod !== undefined) return mod
  if (process.platform !== 'darwin') {
    mod = null
    return mod
  }
  try {
    // CJS singleton — load sync so the native .node is ready before show.
    mod = require('electron-liquid-glass') as LiquidGlass
  } catch (err) {
    console.error('electron-liquid-glass unavailable:', err)
    mod = null
  }
  return mod
}

/** True when we should open a transparent window for glass. */
export function glassAvailable(): boolean {
  const g = load()
  try {
    return !!g?.isGlassSupported()
  } catch {
    return false
  }
}

/**
 * Attach an NSGlassEffectView under the web contents. Call after first load.
 * Returns whether glass is active for the renderer chrome.
 */
export function applyGlass(win: BrowserWindow): boolean {
  const g = load()
  if (!g?.isGlassSupported()) return false
  try {
    // Custom traffic lights live in the renderer; keep the native ones hidden.
    win.setWindowButtonVisibility(false)
    const id = g.addView(win.getNativeWindowHandle(), {
      cornerRadius: 0,
      tintColor: '#080D17cc',
      opaque: false
    })
    if (id < 0) return false
    g.unstable_setVariant(id, g.GlassMaterialVariant.sidebar)
    return true
  } catch (err) {
    console.error('failed to apply liquid glass:', err)
    return false
  }
}
