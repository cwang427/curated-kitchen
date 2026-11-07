import { useEffect, useState } from 'react'
import type { CookedEntry, CookedMap, OtherCook } from '../../src/lib/ratings'

// "Made it" + scores against fixtures, in memory, so the sheet works when
// tapped. Add ?fresh to start with nothing made.
const DAY = 86_400_000
const fresh = typeof location !== 'undefined' && location.search.includes('fresh')
let mine: CookedMap = fresh
  ? {}
  : {
      'cacio-e-pepe': { madeAt: Date.now() - 3 * DAY, rating: 8 },
      'roast-chicken': { madeAt: Date.now() - 40 * DAY, rating: null },
      'extra-2': { madeAt: Date.now() - DAY, rating: 9 },
      'extra-4': { madeAt: Date.now() - 200 * DAY, rating: 10 },
    }

// The preview kitchen's other people (see the AuthProvider stub).
const OTHERS: Record<string, { name: string; cooked: CookedMap }> = {
  partner_uid: {
    name: 'Jordan',
    cooked: { 'cacio-e-pepe': { madeAt: 1, rating: 7 }, 'roast-chicken': { madeAt: 1, rating: 9 } },
  },
  friend_uid: { name: 'Sam', cooked: { 'cacio-e-pepe': { madeAt: 1, rating: null } } },
}

const listeners = new Set<() => void>()
function publish(next: CookedMap): void {
  mine = next
  for (const listener of listeners) listener()
}

export function watchMyCooked(): () => void {
  return () => {}
}

export function useMyCooked(): CookedMap {
  const [cooked, setCooked] = useState(mine)
  useEffect(() => {
    const listener = () => setCooked(mine)
    listeners.add(listener)
    return () => void listeners.delete(listener)
  }, [])
  return cooked
}

export function useOthersCooked(uids: string[], slug: string | null): OtherCook[] {
  if (!slug) return []
  return uids.flatMap((uid) => {
    const entry: CookedEntry | undefined = OTHERS[uid]?.cooked[slug]
    return entry ? [{ uid, name: OTHERS[uid].name, entry }] : []
  })
}

export async function markMade(_uid: string, slug: string): Promise<void> {
  publish({ ...mine, [slug]: { rating: mine[slug]?.rating ?? null, madeAt: Date.now() } })
}

export async function setMyRating(_uid: string, slug: string, rating: number | null, current: CookedEntry | null): Promise<void> {
  publish({ ...mine, [slug]: { madeAt: current?.madeAt ?? Date.now(), rating } })
}

export async function unmarkMade(_uid: string, slug: string): Promise<void> {
  const next = { ...mine }
  delete next[slug]
  publish(next)
}

export async function carryCooked(_uid: string, slug: string, entry: CookedEntry): Promise<void> {
  publish({ ...mine, [slug]: entry })
}

let ratePrompt: string | null = null
export function askToRate(slug: string): void {
  ratePrompt = slug
}
export function takeRatePrompt(slug: string): boolean {
  if (ratePrompt !== slug) return false
  ratePrompt = null
  return true
}
