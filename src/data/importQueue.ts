import { useEffect, useState } from 'react'
import { auth } from '../lib/firebase'
import { AI_IMPORT_URL } from '../lib/aiConfig'
import { finishLinkImport, type WorkerAnswer } from './aiImport'
import { createPhoto } from './photos'
import { createRecipeInHousehold } from './recipes'
import type { RecipeSeed } from '../lib/types'

/**
 * The import queue, app side. The Worker keeps each person's queue and tries
 * the links on a timer, even while the app is closed (worker/src/queue.ts).
 * A finished import waits there until the app is next open; then this saves
 * it — photos downloaded and shrunk on the phone, the recipe written to the
 * kitchen it was queued for, with the cook's own sign-in — and says so.
 */

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
  /** Trying again can't help (a paywall, a site that refuses). */
  final?: boolean
}

// One shared copy of the list, so the background saver and the Add a recipe
// screen always agree.
type Snapshot = { items: QueueItem[]; available: boolean | null }
let snapshot: Snapshot = { items: [], available: null }
const listeners = new Set<() => void>()
function publish(next: Partial<Snapshot>): void {
  snapshot = { ...snapshot, ...next }
  for (const listener of listeners) listener()
}

/** The queue as it stands: its items, and whether the Worker has a queue at
 * all (null until we've asked; false for a Worker older than 0.49). */
export function useImportQueue(): Snapshot {
  const [state, setState] = useState(snapshot)
  useEffect(() => {
    const listener = () => setState(snapshot)
    listeners.add(listener)
    setState(snapshot)
    return () => void listeners.delete(listener)
  }, [])
  return state
}

async function ask(action: string, body: Record<string, unknown> = {}): Promise<{ status: number; data: Record<string, unknown> }> {
  const user = auth.currentUser
  if (!AI_IMPORT_URL || !user) return { status: 0, data: {} }
  const res = await fetch(`${AI_IMPORT_URL}/queue/${action}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${await user.getIdToken()}` },
    body: JSON.stringify(body),
  })
  return { status: res.status, data: (await res.json().catch(() => ({}))) as Record<string, unknown> }
}

/** Ask the Worker for the queue. An older Worker has no queue (it answers
 * something else); then the queue's buttons stay hidden. */
export async function refreshQueue(): Promise<void> {
  try {
    const { status, data } = await ask('list')
    if (status === 200 && Array.isArray(data.items)) publish({ items: data.items as QueueItem[], available: true })
    else if (status !== 0 && status < 500) publish({ available: false })
  } catch {
    /* offline — keep what we had */
  }
}

/** Queue a link for the kitchen. `tried`: it just failed, so the first retry
 * waits a minute; otherwise it's tried straight away. */
export async function addToQueue(url: string, householdId: string, tried: boolean): Promise<void> {
  const { status, data } = await ask('add', { url, householdId, tried })
  if (status !== 200) throw new Error(typeof data.error === 'string' ? data.error : 'Couldn’t add it to the queue.')
  if (Array.isArray(data.items)) publish({ items: data.items as QueueItem[] })
  scheduleRefresh()
}

async function act(action: 'remove' | 'retry' | 'without-photos', id: string): Promise<void> {
  await ask(action, { id })
  await refreshQueue()
  scheduleRefresh()
}
export const removeFromQueue = (id: string) => act('remove', id)
export const retryQueued = (id: string) => act('retry', id)
/** "Save without photos", for a link whose photos never came in a day of tries. */
export const saveQueuedWithoutPhotos = (id: string) => act('without-photos', id)

// ---- The background saver ---------------------------------------------------

/** What was just saved, for the "Added to your kitchen" note. */
export type SavedNote = { slug: string; title: string }
let onSaved: ((note: SavedNote) => void) | null = null
export function onQueueSaved(listener: ((note: SavedNote) => void) | null): void {
  onSaved = listener
}

let collecting = false
let timer: ReturnType<typeof setTimeout> | undefined

/** Check again soon while anything is in motion; otherwise only when the app
 * is opened or brought back (no need to ask every minute for nothing). */
function scheduleRefresh(): void {
  clearTimeout(timer)
  const active = snapshot.items.some((it) => ['waiting', 'working', 'ready', 'saving'].includes(it.status))
  if (!active || document.visibilityState !== 'visible') return
  timer = setTimeout(() => void tick(), 60_000)
}

/** Refresh the list and save whatever has finished. */
export async function tick(): Promise<void> {
  if (collecting) return
  collecting = true
  try {
    await refreshQueue()
    for (const item of snapshot.items.filter((it) => it.status === 'ready')) await collect(item)
    if (snapshot.items.some((it) => it.status === 'ready')) await refreshQueue()
  } finally {
    collecting = false
    scheduleRefresh()
  }
}

/** Where saving goes — the kitchen's photos and recipes in Firestore. An
 * object so a test can stand in for Firestore. */
export const kitchenStore = { createPhoto, createRecipeInHousehold }

/** Store the recipe's photos (still data URLs from the download) as photo
 * docs in the kitchen, as the editor does on Save, then the recipe itself. */
async function saveToKitchen(seed: RecipeSeed, householdId: string, uid: string): Promise<string> {
  const steps = await Promise.all(
    seed.steps.map(async (step) =>
      step.images?.length
        ? { ...step, images: await Promise.all(step.images.map((img) => (img.startsWith('data:') ? kitchenStore.createPhoto(householdId, uid, img) : img))) }
        : step,
    ),
  )
  const cover =
    seed.cover && seed.cover.photo.startsWith('data:')
      ? { ...seed.cover, photo: await kitchenStore.createPhoto(householdId, uid, seed.cover.photo) }
      : seed.cover
  return kitchenStore.createRecipeInHousehold({ ...seed, steps, cover }, householdId, uid)
}

async function collect(item: QueueItem): Promise<void> {
  const user = auth.currentUser
  if (!user) return
  const taken = await ask('take', { id: item.id })
  if (taken.status !== 200) return // another of the cook's devices is saving it, or it isn't ready
  const answer = taken.data.result as WorkerAnswer
  try {
    const result = await finishLinkImport(answer, item.url, await user.getIdToken())
    const photos = result.link?.photos
    // The owner's rule: a queued recipe keeps trying for its photos (the
    // Worker imports it again later) unless the cook chose to save it without.
    if (!item.withoutPhotos && photos && photos.wanted > 0 && photos.got === 0) {
      await ask('photos-failed', { id: item.id })
      return
    }
    const slug = await saveToKitchen(result.seed, item.householdId, user.uid)
    await ask('done', { id: item.id, slug, title: result.seed.title, photos })
    onSaved?.({ slug, title: result.seed.title })
  } catch (cause) {
    const denied = (cause as { code?: string }).code === 'permission-denied'
    await ask('save-failed', {
      id: item.id,
      message: denied
        ? 'Couldn’t save it to that kitchen — you may no longer be a member.'
        : cause instanceof Error
          ? cause.message
          : 'Couldn’t save it to your kitchen.',
    })
  }
}

/** Started once, by the app shell: check on open, when the app comes back to
 * the front, and every minute while something's in motion. */
export function startImportQueue(): () => void {
  const onVisible = () => {
    if (document.visibilityState === 'visible') void tick()
    else clearTimeout(timer)
  }
  document.addEventListener('visibilitychange', onVisible)
  void tick()
  return () => {
    document.removeEventListener('visibilitychange', onVisible)
    clearTimeout(timer)
  }
}
