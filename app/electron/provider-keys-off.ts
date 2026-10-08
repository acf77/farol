/**
 * Vendor keys the user switched off, mirrored from settings so spawn sites can
 * read them synchronously. `store.ts` refreshes it on every settings load/save.
 */

import type { ProviderKey } from '../shared/ai'

let off: readonly ProviderKey[] = []

export function providerKeyOff(key: ProviderKey): boolean {
  return off.includes(key)
}

export function setProviderKeysOff(keys: readonly ProviderKey[] | undefined): void {
  off = keys ?? []
}
