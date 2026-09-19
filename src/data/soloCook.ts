import type { SyncTimer } from '../lib/types'

/**
 * A solo (unsynced) cook's progress, kept in THIS browser's localStorage so you
 * can step out — glance at the grocery list, background the app, let the screen
 * lock — and resume where you left off. It writes nothing shared; the
 * cook-together session doc is what syncs across phones. One slot: you resume
 * the last thing you were making.
 */
export interface SoloCook {
  slug: string
  scale: number
  stepIndex: number
  timers: SyncTimer[]
  updatedAt: number
}

const KEY = 'ck.cook.solo'
// Forget an in-progress solo cook after a day — by then it's finished or
// abandoned, and a stale "resume" banner would just be noise.
const STALE_MS = 24 * 60 * 60 * 1000

export function readSoloCook(now = Date.now()): SoloCook | null {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return null
    const data = JSON.parse(raw) as SoloCook
    if (!data || typeof data.slug !== 'string') return null
    if (now - (data.updatedAt ?? 0) > STALE_MS) return null
    return data
  } catch {
    // Private mode, blocked storage, or bad JSON — just no resume available.
    return null
  }
}

export function writeSoloCook(cook: SoloCook): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(cook))
  } catch {
    // Storage full or blocked — resume simply won't be offered.
  }
}

export function clearSoloCook(): void {
  try {
    localStorage.removeItem(KEY)
  } catch {
    // Ignore.
  }
}
