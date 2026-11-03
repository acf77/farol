/** Set in localStorage once someone has answered or dismissed the nudge. */
export const FEEDBACK_NUDGE_KEY = 'farol.feedbackNudgeDone'

/**
 * Picks the one pipeline card that asks "how did it go?": the first green one
 * this window shows. A chat with several passing runs then asks once, not on
 * every card.
 */
export function createNudgeSlot() {
  let owner: string | null = null
  return {
    claim(cardKey: string, passed: boolean): boolean {
      if (!passed) return false
      if (owner === null) owner = cardKey
      return owner === cardKey
    }
  }
}

/** Whether the nudge was already handled. Storage that can't be read counts as handled, so it never nags. */
export function nudgeDone(storage: Pick<Storage, 'getItem'> | undefined): boolean {
  try {
    return storage?.getItem(FEEDBACK_NUDGE_KEY) === '1'
  } catch {
    return true
  }
}
