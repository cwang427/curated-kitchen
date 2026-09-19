import { useEffect, useState } from 'react'
import {
  collection,
  deleteDoc,
  doc,
  getDocs,
  onSnapshot,
  serverTimestamp,
  setDoc,
  updateDoc,
  writeBatch,
  type DocumentData,
} from 'firebase/firestore'
import { db } from '../lib/firebase'
import { canonicalize, planMerge, type Addition } from '../lib/grocery'
import type { GroceryCategory, GroceryItem } from '../lib/types'

/**
 * The shared grocery list: one document per household (id = householdId) with an
 * `items` subcollection, so two people checking things off at once each write
 * their own item doc and never clobber each other. Realtime via onSnapshot.
 */

function toMillis(value: unknown): number | null {
  return value && typeof value === 'object' && 'toMillis' in value
    ? (value as { toMillis: () => number }).toMillis()
    : null
}

function toItem(id: string, data: DocumentData): GroceryItem {
  return {
    id,
    name: data.name ?? '',
    canonical: data.canonical ?? id,
    quantity: data.quantity ?? null,
    quantityMax: data.quantityMax ?? null,
    unit: data.unit ?? null,
    category: (data.category ?? 'other') as GroceryCategory,
    checked: data.checked ?? false,
    note: data.note ?? null,
    addedBy: data.addedBy ?? null,
    createdAt: toMillis(data.createdAt),
    updatedAt: toMillis(data.updatedAt),
  }
}

function itemsRef(householdId: string) {
  return collection(db, 'lists', householdId, 'items')
}

/** Firestore denies writes to items until the parent list doc exists. */
async function ensureList(householdId: string): Promise<void> {
  await setDoc(
    doc(db, 'lists', householdId),
    { householdId, name: 'Groceries', createdAt: serverTimestamp() },
    { merge: true },
  )
}

export interface GroceryState {
  items: GroceryItem[]
  loading: boolean
  error: string | null
}

export function useGroceryList(householdId: string | null): GroceryState {
  const [items, setItems] = useState<GroceryItem[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!householdId) {
      setItems([])
      setLoading(false)
      return
    }
    setLoading(true)
    return onSnapshot(
      itemsRef(householdId),
      (snapshot) => {
        setItems(snapshot.docs.map((d) => toItem(d.id, d.data())))
        setError(null)
        setLoading(false)
      },
      (cause) => {
        setError(cause.message)
        setLoading(false)
      },
    )
  }, [householdId])

  return { items, loading, error }
}

/** Add recipe ingredients (or any additions), merging by canonical + unit. */
export async function addToList(
  householdId: string,
  uid: string,
  additions: Addition[],
): Promise<{ created: number; updated: number }> {
  if (additions.length === 0) return { created: 0, updated: 0 }
  await ensureList(householdId)

  // Read the current items so the merge sees what's already there. The list is
  // small, so a one-off read is fine and avoids racing the live snapshot.
  const snapshot = await getDocs(itemsRef(householdId))
  const existing = snapshot.docs.map((d) => toItem(d.id, d.data()))
  const plan = planMerge(existing, additions)

  const batch = writeBatch(db)
  for (const create of plan.creates) {
    batch.set(doc(itemsRef(householdId)), {
      name: create.name,
      canonical: create.canonical,
      quantity: create.quantity ?? null,
      quantityMax: create.quantityMax ?? null,
      unit: create.unit ?? null,
      category: create.category,
      checked: false,
      note: create.note ?? null,
      addedBy: uid,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    })
  }
  for (const update of plan.updates) {
    batch.update(doc(itemsRef(householdId), update.id), {
      quantity: update.quantity,
      quantityMax: update.quantityMax,
      updatedAt: serverTimestamp(),
    })
  }
  await batch.commit()
  return { created: plan.creates.length, updated: plan.updates.length }
}

/** Manual quick-add of a single free-typed item. */
export async function quickAdd(
  householdId: string,
  uid: string,
  name: string,
  category: GroceryCategory,
): Promise<void> {
  const trimmed = name.trim()
  if (!trimmed) return
  await addToList(householdId, uid, [
    {
      name: trimmed,
      canonical: canonicalize(trimmed),
      quantity: null,
      quantityMax: null,
      unit: null,
      category,
      note: null,
    },
  ])
}

export async function toggleItem(householdId: string, itemId: string, checked: boolean): Promise<void> {
  await updateDoc(doc(itemsRef(householdId), itemId), { checked, updatedAt: serverTimestamp() })
}

export async function removeItem(householdId: string, itemId: string): Promise<void> {
  await deleteDoc(doc(itemsRef(householdId), itemId))
}

/** Remove everything already checked off — a one-tap tidy after shopping. */
export async function clearChecked(householdId: string): Promise<number> {
  const snapshot = await getDocs(itemsRef(householdId))
  const checked = snapshot.docs.filter((d) => d.data().checked === true)
  if (checked.length === 0) return 0
  const batch = writeBatch(db)
  for (const d of checked) batch.delete(d.ref)
  await batch.commit()
  return checked.length
}
