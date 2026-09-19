import { useEffect, useState } from 'react'
import {
  addDoc,
  collection,
  deleteDoc,
  doc,
  onSnapshot,
  serverTimestamp,
  setDoc,
  updateDoc,
  writeBatch,
  type DocumentData,
} from 'firebase/firestore'
import { db } from '../lib/firebase'
import { describeFirestoreError } from '../lib/errors'
import type { PlanEntry } from '../lib/types'

/**
 * The shared meal plan: one document per household (id = householdId) with an
 * `entries` subcollection, so two people planning at once each write their own
 * entry and never clobber each other — the same shape as the grocery list.
 * Realtime via onSnapshot.
 */

function toMillis(value: unknown): number | null {
  return value && typeof value === 'object' && 'toMillis' in value
    ? (value as { toMillis: () => number }).toMillis()
    : null
}

function toEntry(id: string, data: DocumentData): PlanEntry {
  return {
    id,
    recipeSlug: data.recipeSlug ?? '',
    recipeTitle: data.recipeTitle ?? 'Untitled',
    date: data.date ?? null,
    scale: typeof data.scale === 'number' ? data.scale : 1,
    addedBy: data.addedBy ?? null,
    createdAt: toMillis(data.createdAt),
  }
}

function entriesRef(householdId: string) {
  return collection(db, 'plans', householdId, 'entries')
}

/** Firestore denies writes to entries until the parent plan doc exists. */
async function ensurePlan(householdId: string): Promise<void> {
  await setDoc(
    doc(db, 'plans', householdId),
    { householdId, createdAt: serverTimestamp() },
    { merge: true },
  )
}

export interface PlanState {
  entries: PlanEntry[]
  loading: boolean
  error: string | null
}

export function usePlan(householdId: string | null): PlanState {
  const [entries, setEntries] = useState<PlanEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!householdId) {
      setEntries([])
      setLoading(false)
      return
    }
    setLoading(true)
    return onSnapshot(
      entriesRef(householdId),
      (snapshot) => {
        setEntries(snapshot.docs.map((d) => toEntry(d.id, d.data())))
        setError(null)
        setLoading(false)
      },
      (cause) => {
        setError(describeFirestoreError(cause, 'load the meal plan'))
        setLoading(false)
      },
    )
  }, [householdId])

  return { entries, loading, error }
}

export interface NewPlanEntry {
  recipeSlug: string
  recipeTitle: string
  date: string | null
  scale: number
}

export async function addPlanEntry(
  householdId: string,
  uid: string,
  entry: NewPlanEntry,
): Promise<void> {
  await ensurePlan(householdId)
  await addDoc(entriesRef(householdId), {
    recipeSlug: entry.recipeSlug,
    recipeTitle: entry.recipeTitle,
    date: entry.date,
    scale: entry.scale,
    addedBy: uid,
    createdAt: serverTimestamp(),
  })
}

/** Move a planned meal to a different day (or to "anytime" with null). */
export async function setPlanEntryDate(
  householdId: string,
  entryId: string,
  date: string | null,
): Promise<void> {
  await updateDoc(doc(entriesRef(householdId), entryId), { date })
}

export async function removePlanEntry(householdId: string, entryId: string): Promise<void> {
  await deleteDoc(doc(entriesRef(householdId), entryId))
}

/** Clear the whole plan — a one-tap reset after the week's shopping is done. */
export async function clearPlan(householdId: string, entryIds: string[]): Promise<number> {
  if (entryIds.length === 0) return 0
  const batch = writeBatch(db)
  for (const id of entryIds) batch.delete(doc(entriesRef(householdId), id))
  await batch.commit()
  return entryIds.length
}
