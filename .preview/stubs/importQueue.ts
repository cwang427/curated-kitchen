import { useEffect, useState } from 'react'

/** Preview: an in-memory import queue. Open /add?queuedemo to start with one
 * item in every state; adding a link puts it in "waiting". */

export type QueueStatus = 'waiting' | 'working' | 'ready' | 'saving' | 'photos-unavailable' | 'failed' | 'saved'
export interface QueueItem {
  id: string
  url: string
  householdId: string
  addedAt: number
  status: QueueStatus
  attempts: number
  nextAt: number
  note?: string
  title?: string
  slug?: string
  savedAt?: number
  photos?: { got: number; wanted: number }
  withoutPhotos?: boolean
  final?: boolean
}
export type SavedNote = { slug: string; title: string }

const now = Date.now()
const demo: QueueItem[] = [
  { id: 'a', url: 'https://www.seriouseats.com/the-best-corn-chowder-recipe', householdId: 'h', addedAt: now - 5 * 60_000, status: 'saved', attempts: 2, nextAt: now, title: 'The Best Corn Chowder', slug: 'cacio-e-pepe', photos: { got: 6, wanted: 6 } },
  { id: 'b', url: 'https://www.seriouseats.com/pressure-cooker-ragu-bolognese', householdId: 'h', addedAt: now - 4 * 60_000, status: 'waiting', attempts: 3, nextAt: now + 9 * 60_000, note: 'The recipe reader was busy' },
  { id: 'c', url: 'https://www.bonappetit.com/recipe/crispy-rice-salad', householdId: 'h', addedAt: now - 3 * 60_000, status: 'working', attempts: 1, nextAt: now },
  { id: 'd', url: 'https://www.seriouseats.com/sichuan-dry-fried-green-beans', householdId: 'h', addedAt: now - 2 * 60_000, status: 'photos-unavailable', attempts: 20, nextAt: now, title: 'Sichuan Dry-Fried Green Beans', note: 'The recipe came through, but its photos never did' },
  { id: 'e', url: 'https://cooking.nytimes.com/recipes/1017518-panzanella', householdId: 'h', addedAt: now - 60_000, status: 'failed', final: true, attempts: 1, nextAt: now, note: 'NYT Cooking recipes are for subscribers only, so the app can’t open the link — copy the recipe text (or take a screenshot) and add it that way.' },
]
let snapshot = {
  items: typeof location !== 'undefined' && location.search.includes('queuedemo') ? demo : ([] as QueueItem[]),
  available: true as boolean | null,
}
const listeners = new Set<() => void>()
const publish = (items: QueueItem[]) => {
  snapshot = { ...snapshot, items }
  for (const l of listeners) l()
}

export function useImportQueue() {
  const [state, setState] = useState(snapshot)
  useEffect(() => {
    const l = () => setState(snapshot)
    listeners.add(l)
    setState(snapshot)
    return () => void listeners.delete(l)
  }, [])
  return state
}
export async function refreshQueue() {}
export async function addToQueue(url: string, householdId: string, tried: boolean) {
  publish([...snapshot.items, { id: String(Math.random()), url, householdId, addedAt: Date.now(), status: 'waiting', attempts: 0, nextAt: Date.now() + (tried ? 60_000 : 0), note: tried ? 'Couldn’t be read just now' : undefined }])
}
export async function removeFromQueue(id: string) {
  publish(snapshot.items.filter((it) => it.id !== id))
}
export async function retryQueued(id: string) {
  publish(snapshot.items.map((it) => (it.id === id ? { ...it, status: 'waiting' as const, attempts: 0, nextAt: Date.now(), note: 'Trying again' } : it)))
}
export async function saveQueuedWithoutPhotos(id: string) {
  publish(snapshot.items.map((it) => (it.id === id ? { ...it, status: 'saving' as const } : it)))
}
let saved: ((n: SavedNote) => void) | null = null
export function onQueueSaved(l: ((n: SavedNote) => void) | null) {
  saved = l
  // ?queuetoast shows the "Added to your kitchen" note.
  if (l && typeof location !== 'undefined' && location.search.includes('queuetoast')) setTimeout(() => saved?.({ slug: 'cacio-e-pepe', title: 'The Best Corn Chowder' }), 300)
}
export async function tick() {}
export function startImportQueue() {
  return () => {}
}
