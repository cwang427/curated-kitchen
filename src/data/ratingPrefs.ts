import { useEffect, useState } from 'react'
import type { ScorePreference } from '../lib/ratings'

/*
 * Which score a recipe goes by when it has both yours and the kitchen's —
 * on its kitchen card and for the Top rated filter (src/lib/ratings.ts,
 * recipeScore). A per-phone setting (Settings › Ratings): a personal view
 * preference, so no Firestore field and no rules. Storage can be blocked
 * (private browsing): then it's simply "mine" each time.
 */
const KEY = 'ck.ratings.prefer'
const listeners = new Set<() => void>()

export function scorePreference(): ScorePreference {
  try {
    return localStorage.getItem(KEY) === 'kitchen' ? 'kitchen' : 'mine'
  } catch {
    return 'mine'
  }
}

export function setScorePreference(prefer: ScorePreference): void {
  try {
    if (prefer === 'mine') localStorage.removeItem(KEY)
    else localStorage.setItem(KEY, prefer)
  } catch {
    // Not saved, but this screen still switches (below).
  }
  current = prefer
  for (const listener of listeners) listener()
}

let current: ScorePreference = scorePreference()

/** The setting, live: the kitchen re-sorts the moment it's changed. */
export function useScorePreference(): ScorePreference {
  const [prefer, setPrefer] = useState(current)
  useEffect(() => {
    const listener = () => setPrefer(current)
    listeners.add(listener)
    listener()
    return () => void listeners.delete(listener)
  }, [])
  return prefer
}
