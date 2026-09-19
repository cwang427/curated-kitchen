import { useEffect, useState } from 'react'
import type { CookDish } from '../lib/types'

/**
 * The cook board: the dishes you're cooking right now, kept in THIS browser's
 * localStorage. It's personal to a device and writes nothing shared — the
 * two-phone "cook together" session doc is what syncs across phones. Its job is
 * to let several cooks run at once (the ribs braise while the rice simmers) and
 * survive stepping out — glance at the grocery list, background the app, let the
 * screen lock — resuming each dish where you left off. Timers live on each dish
 * endsAt-first, so they keep counting down while its cook page is closed.
 *
 * A dish is forgotten a day after its last touch: by then it's cooked or
 * abandoned, and a stale "still cooking" banner would just be noise.
 */

const KEY = 'ck.cook.board'
const STALE_MS = 24 * 60 * 60 * 1000

export interface CookBoard {
  dishes: CookDish[]
}

// In-tab subscribers. localStorage's `storage` event only fires in OTHER tabs,
// so we notify our own listeners on every write to keep this tab reactive too.
const listeners = new Set<() => void>()
function notify(): void {
  for (const fn of listeners) fn()
}

function isDish(value: unknown): value is CookDish {
  return !!value && typeof (value as CookDish).slug === 'string'
}

export function readBoard(now = Date.now()): CookBoard {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return { dishes: [] }
    const data = JSON.parse(raw) as CookBoard
    const dishes = Array.isArray(data?.dishes) ? data.dishes.filter(isDish) : []
    // Drop dishes gone stale; a day-old cook is finished or abandoned.
    const fresh = dishes.filter((d) => now - (d.updatedAt ?? 0) <= STALE_MS)
    return { dishes: fresh }
  } catch {
    // Private mode, blocked storage, or bad JSON — just an empty board.
    return { dishes: [] }
  }
}

function write(board: CookBoard): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(board))
  } catch {
    // Storage full or blocked — the board simply won't persist.
  }
  notify()
}

/** The dish for a recipe, if it's on the board. */
export function getDish(slug: string): CookDish | null {
  return readBoard().dishes.find((d) => d.slug === slug) ?? null
}

/** Add or replace a dish (keyed by slug), keeping the others in place. */
export function upsertDish(dish: CookDish): void {
  const board = readBoard()
  const rest = board.dishes.filter((d) => d.slug !== dish.slug)
  write({ dishes: [...rest, dish] })
}

/** Remove one dish (finished, or "start over"); the rest keep cooking. */
export function removeDish(slug: string): void {
  const board = readBoard()
  const dishes = board.dishes.filter((d) => d.slug !== slug)
  if (dishes.length === board.dishes.length) return
  write({ dishes })
}

/** Clear the whole board. */
export function clearBoard(): void {
  write({ dishes: [] })
}

/**
 * Subscribe to the board and re-render on change — writes from this tab (via the
 * in-tab listeners) and from other tabs (via the `storage` event). Reads fresh
 * on mount so a dish added just before this mounted still shows.
 */
export function useCookBoard(): CookBoard {
  const [board, setBoard] = useState<CookBoard>(() => readBoard())

  useEffect(() => {
    const update = () => setBoard(readBoard())
    listeners.add(update)
    const onStorage = (e: StorageEvent) => {
      if (e.key === null || e.key === KEY) update()
    }
    window.addEventListener('storage', onStorage)
    update() // catch any write between the initial read and this effect
    return () => {
      listeners.delete(update)
      window.removeEventListener('storage', onStorage)
    }
  }, [])

  return board
}
