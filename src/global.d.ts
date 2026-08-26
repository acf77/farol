import type { BuildFlowApi } from '@shared/types'

declare global {
  interface Window {
    buildflow: BuildFlowApi
  }
}

export {}
