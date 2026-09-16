import { useCallback, useEffect, useState } from 'react'
import type { ProviderUsage } from '@shared/types'

const api = window.farol
const REFRESH_MS = 60_000

/** Main-process provider readings, refreshed on an interval and when the window returns. */
export function useUsage(): { usage: ProviderUsage[]; refresh: () => void } {
  const [usage, setUsage] = useState<ProviderUsage[]>([])

  const refresh = useCallback(() => {
    void api.usage
      .read()
      .then(setUsage)
      .catch(() => undefined)
  }, [])

  useEffect(() => {
    refresh()
    const timer = window.setInterval(refresh, REFRESH_MS)
    const onVisible = (): void => {
      if (!document.hidden) refresh()
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [refresh])

  return { usage, refresh }
}
