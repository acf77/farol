import type { FarolApi } from '@shared/types'

declare global {
  interface Window {
    farol: FarolApi
  }
}

export {}
