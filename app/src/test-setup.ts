if (typeof globalThis.window === 'undefined') {
  ;(globalThis as unknown as { window: unknown }).window = globalThis
}
