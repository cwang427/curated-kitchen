import { useEffect, useState } from 'react'
import { doc, onSnapshot, serverTimestamp, setDoc, updateDoc, type DocumentData } from 'firebase/firestore'
import { db } from '../lib/firebase'
import type { CookSession, SyncTimer } from '../lib/types'

/**
 * The live "cook together" session: one doc per household (id = householdId).
 * Both phones subscribe, so tapping Next or starting a timer on one shows up on
 * the other. Timers are stored endsAt-first (a wall-clock epoch), so each phone
 * derives its own countdown and we only write on real actions (start, pause,
 * reset, dismiss, step change) — never every tick.
 *
 * There is only one session per household at a time: cooking together means
 * cooking the *same* thing, so a second recipe simply replaces the first.
 */

function toMillis(value: unknown): number | null {
  return value && typeof value === 'object' && 'toMillis' in value
    ? (value as { toMillis: () => number }).toMillis()
    : null
}

function toSession(data: DocumentData): CookSession {
  return {
    householdId: data.householdId ?? '',
    recipeSlug: data.recipeSlug ?? '',
    recipeTitle: data.recipeTitle ?? '',
    scale: typeof data.scale === 'number' ? data.scale : 1,
    stepIndex: typeof data.stepIndex === 'number' ? data.stepIndex : 0,
    timers: Array.isArray(data.timers) ? (data.timers as SyncTimer[]) : [],
    startedBy: data.startedBy ?? null,
    startedByName: data.startedByName ?? null,
    updatedAt: toMillis(data.updatedAt),
    active: data.active === true,
  }
}

function sessionRef(householdId: string) {
  return doc(db, 'sessions', householdId)
}

export interface CookSessionState {
  session: CookSession | null
  loading: boolean
}

/** Subscribe to the household's cook session. Returns null unless one is active. */
export function useCookSession(householdId: string | null): CookSessionState {
  const [session, setSession] = useState<CookSession | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!householdId) {
      setSession(null)
      setLoading(false)
      return
    }
    setLoading(true)
    return onSnapshot(
      sessionRef(householdId),
      (snapshot) => {
        const data = snapshot.exists() ? toSession(snapshot.data()) : null
        setSession(data?.active ? data : null)
        setLoading(false)
      },
      // A read failure here just means no sync; cooking still works solo.
      () => {
        setSession(null)
        setLoading(false)
      },
    )
  }, [householdId])

  return { session, loading }
}

export interface StartCookSession {
  recipeSlug: string
  recipeTitle: string
  scale: number
  stepIndex: number
  timers: SyncTimer[]
  startedByName: string | null
}

/** Begin (or replace) the shared session, seeding it with the caller's state. */
export async function startCookSession(
  householdId: string,
  uid: string,
  init: StartCookSession,
): Promise<void> {
  await setDoc(sessionRef(householdId), {
    householdId,
    recipeSlug: init.recipeSlug,
    recipeTitle: init.recipeTitle,
    scale: init.scale,
    stepIndex: init.stepIndex,
    timers: init.timers,
    startedBy: uid,
    startedByName: init.startedByName,
    active: true,
    updatedAt: serverTimestamp(),
  })
}

export async function setSessionStep(householdId: string, stepIndex: number): Promise<void> {
  await updateDoc(sessionRef(householdId), { stepIndex, updatedAt: serverTimestamp() })
}

export async function setSessionTimers(householdId: string, timers: SyncTimer[]): Promise<void> {
  await updateDoc(sessionRef(householdId), { timers, updatedAt: serverTimestamp() })
}

/** Stop the session for both phones; the doc lingers but reads as inactive. */
export async function endCookSession(householdId: string): Promise<void> {
  await updateDoc(sessionRef(householdId), { active: false, updatedAt: serverTimestamp() })
}
