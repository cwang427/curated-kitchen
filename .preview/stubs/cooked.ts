import { useEffect, useState } from 'react'
import type { CookedEntry, CookedMap, KitchenPerson } from '../../src/lib/ratings'

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
      // Where Settings › Ratings decides Top rated: yours 5 vs the kitchen's
      // 7 (green beans), yours 8 vs the kitchen's 6 (Caesar).
      'extra-6': { madeAt: Date.now() - 9 * DAY, rating: 5 },
      'extra-10': { madeAt: Date.now() - 9 * DAY, rating: 8 },
    }

// The preview kitchen's other people (see the AuthProvider stub). Covers each
// tile case under ?many: only you scored it (extra-4), only others (extra-0),
// both (extra-2, cacio), and made-not-scored with others' scores (roast).
const OTHERS: Record<string, KitchenPerson> = {
  partner_uid: {
    uid: 'partner_uid',
    name: 'Jordan',
    cooked: {
      'cacio-e-pepe': { madeAt: 1, rating: 7 },
      'roast-chicken': { madeAt: 1, rating: 9 },
      'extra-0': { madeAt: 1, rating: 9 },
      'extra-2': { madeAt: 1, rating: 7 },
      'extra-9': { madeAt: 1, rating: 7 },
      'extra-6': { madeAt: 1, rating: 9 },
      'extra-10': { madeAt: 1, rating: 4 },
    },
  },
  friend_uid: {
    uid: 'friend_uid',
    name: 'Sam',
    // extra-9 (dumplings, "1 hr 30 min") → the longest line: "★ 7.5/10".
    cooked: { 'cacio-e-pepe': { madeAt: 1, rating: null }, 'extra-0': { madeAt: 1, rating: 8 }, 'extra-9': { madeAt: 1, rating: 8 } },
  },
}
let kitchenUids: string[] = []

const listeners = new Set<() => void>()
function publish(next: CookedMap): void {
  mine = next
  for (const listener of listeners) listener()
}

export function watchMyCooked(): () => void {
  return () => {}
}

export function watchKitchenCooked(uids: string[]): () => void {
  kitchenUids = uids
  publish(mine)
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

export function useKitchenCooked(): KitchenPerson[] {
  const people = () => kitchenUids.flatMap((uid) => (OTHERS[uid] ? [OTHERS[uid]] : []))
  const [list, setList] = useState(people)
  useEffect(() => {
    const listener = () => setList(people())
    listeners.add(listener)
    listener()
    return () => void listeners.delete(listener)
  }, [])
  return list
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
