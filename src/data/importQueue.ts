import { useEffect, useState } from 'react'
import { auth } from '../lib/firebase'
import { AI_IMPORT_URL, aiImportConfigured } from '../lib/aiConfig'
import {
  askWorker,
  finishLinkImport,
  seedFromAnswer,
  type AiInput,
  type AiPhoto,
  type ImportStage,
  type LinkReport,
  type WorkerAnswer,
} from './aiImport'
import { importRecipeFromUrl } from './urlImport'
import { importRecipeFromText } from '../lib/importText'
import { createPhoto } from './photos'
import { saveForReview } from './recipes'
import type { ImportProgress } from '../lib/importStage'
import type { RecipeSeed } from '../lib/types'

/**
 * Imports, app side. Every import — a link, pasted text, photos or a PDF —
 * runs in the background and lands in the kitchen's "Recipes awaiting review"
 * (saveForReview), where any member can look it over and approve it.
 *
 *  - Links and pasted text go to the Worker's queue (worker/src/queue.ts),
 *    one per person, which runs them — and retries them, even with the app
 *    closed — and reports how each is getting on. A finished one waits there;
 *    the app, whenever it's open, downloads its photos (a phone can shrink
 *    them; the Worker's free plan can't) and saves it, with the cook's own
 *    sign-in.
 *  - Photos and PDFs are too big to park with the Worker, so the app runs
 *    those itself (as it does links and text when the Worker has no queue).
 *    They live only while the app is open.
 */

export type QueueStatus = 'waiting' | 'working' | 'ready' | 'saving' | 'photos-unavailable' | 'failed' | 'saved'

/** A queued import, as the Worker's queue reports it. */
export interface QueueItem {
  id: string
  /** Absent on items queued before 0.50 (all links). */
  kind?: 'link' | 'text'
  url?: string
  /** Pasted text's first line. */
  label?: string
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
  /** While it runs: how it's getting on. */
  stage?: ImportStage
  /** The recipe is in hand; it's still trying for the photos. */
  hasText?: boolean
}

/** An import this app is running itself. */
export interface LocalJob {
  id: string
  kind: 'link' | 'text' | 'photos'
  input: AiInput
  householdId: string
  name: string
  addedAt: number
  status: 'working' | 'failed'
  progress: ImportProgress
  error?: string
}

// One shared copy of it all, so the background saver and the screens agree.
type Snapshot = {
  items: QueueItem[]
  /** Whether the Worker has a queue (null until we've asked; false before 0.49). */
  available: boolean | null
  /** …and takes pasted text too (0.50+). */
  takesText: boolean
  jobs: LocalJob[]
  /** This phone's own progress on queued imports it's saving (photos, saving). */
  saving: Record<string, ImportProgress>
}
let snapshot: Snapshot = { items: [], available: null, takesText: false, jobs: [], saving: {} }
const listeners = new Set<() => void>()
function publish(next: Partial<Snapshot>): void {
  snapshot = { ...snapshot, ...next }
  for (const listener of listeners) listener()
}

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

/** A signed-in request to the Worker (queue/…, notify/…). Throws when
 * offline; status 0 = not signed in or no Worker. */
export async function callWorker(path: string, body: Record<string, unknown> = {}): Promise<{ status: number; data: Record<string, unknown> }> {
  const user = auth.currentUser
  if (!AI_IMPORT_URL || !user) return { status: 0, data: {} }
  const res = await fetch(`${AI_IMPORT_URL}/${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${await user.getIdToken()}` },
    body: JSON.stringify(body),
  })
  return { status: res.status, data: (await res.json().catch(() => ({}))) as Record<string, unknown> }
}

/** Ask the Worker for the queue. An older Worker has no queue (it answers
 * something else); then imports run in the app. */
export async function refreshQueue(): Promise<void> {
  try {
    const { status, data } = await callWorker('queue/list')
    if (status === 200 && Array.isArray(data.items)) publish({ items: data.items as QueueItem[], available: true, takesText: data.text === true })
    else if (status !== 0 && status < 500) publish({ available: false })
  } catch {
    /* offline — keep what we had */
  }
}

/** "www.seriouseats.com/the-best-corn-chowder-recipe" → "seriouseats.com › the-best-corn-chowder-recipe" */
export function shortLink(url: string): string {
  try {
    const { hostname, pathname } = new URL(url)
    const last = pathname.split('/').filter(Boolean).pop() ?? ''
    return `${hostname.replace(/^www\./, '')}${last ? ` › ${decodeURIComponent(last)}` : ''}`
  } catch {
    return url
  }
}

export type NewImport = { url: string } | { text: string } | { images: AiPhoto[]; name: string }

/**
 * Start an import for this kitchen; it's under way when this returns (the
 * list on Add a recipe shows how it's going). Throws only when it couldn't
 * be started at all — a bad link, or offline with a link.
 */
export async function startImport(job: NewImport, householdId: string): Promise<void> {
  if ('images' in job) return void runLocal(newJob('photos', { images: job.images }, householdId, job.name))
  const name = 'url' in job ? shortLink(job.url) : (job.text.split('\n').find((l) => l.trim())?.trim().slice(0, 80) ?? 'Pasted recipe')
  if (aiImportConfigured) {
    if (snapshot.available === null) await refreshQueue()
    // (A Worker from before 0.50 queues links only.)
    if (snapshot.available !== false && ('url' in job || snapshot.takesText || snapshot.available === null)) {
      let status = -1
      let data: Record<string, unknown> = {}
      try {
        ;({ status, data } = await callWorker('queue/add', { ...job, householdId }))
      } catch {
        /* offline */
      }
      if (status === 200 && Array.isArray(data.items)) {
        publish({ items: data.items as QueueItem[], available: true })
        scheduleRefresh(true)
        return
      }
      // The queue said no (a bad link, a full queue): say why.
      if (status === 400 || status === 409) throw new Error(typeof data.error === 'string' ? data.error : 'Couldn’t start that import.')
      if (status === 404 || status === 501) publish({ available: false })
      // Offline: a link needs the internet; pasted text can still be read here.
      if (status === -1 && 'url' in job) throw new Error('You’re offline — connect to the internet and try again.')
    }
  }
  // No queue (or it's down): run it here.
  void runLocal(newJob('url' in job ? 'link' : 'text', job, householdId, name))
}

function newJob(kind: LocalJob['kind'], input: AiInput, householdId: string, name: string): LocalJob {
  const job: LocalJob = { id: `local-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, kind, input, householdId, name, addedAt: Date.now(), status: 'working', progress: { stage: 'starting' } }
  publish({ jobs: [...snapshot.jobs, job] })
  return job
}

/** Queue actions from the list. */
async function act(action: 'remove' | 'retry' | 'without-photos', id: string): Promise<void> {
  await callWorker(`queue/${action}`, { id }).catch(() => undefined)
  await refreshQueue()
  scheduleRefresh(true)
}
export const removeFromQueue = (id: string) => act('remove', id)
export const retryQueued = (id: string) => act('retry', id)
/** "Save without photos", for a recipe still trying for its photos. */
export const saveQueuedWithoutPhotos = (id: string) => act('without-photos', id)

export function removeLocal(id: string): void {
  publish({ jobs: snapshot.jobs.filter((j) => j.id !== id) })
}
export function retryLocal(id: string): void {
  const job = snapshot.jobs.find((j) => j.id === id)
  if (job) void runLocal(job)
}

// ---- Saving ------------------------------------------------------------------

/** A note for the bottom of the screen: "Ready for review: Corn Chowder". */
export type AppNote = {
  text: string
  title: string
  action: { label: string; path: string }
  /** Not on this screen (it shows the news itself). */
  hideOn?: string
}
let onNote: ((note: AppNote) => void) | null = null
export function onAppNote(listener: ((note: AppNote) => void) | null): void {
  onNote = listener
}
export function showAppNote(note: AppNote): void {
  onNote?.(note)
}

/** The cook's name, for "Imported by …" (set by the app shell). */
let importerName: string | null = null
export function setImporterName(name: string | null): void {
  importerName = name
}

/** Where saving goes — the kitchen's photos and recipes in Firestore. An
 * object so a test can stand in for Firestore. */
export const kitchenStore = { createPhoto, saveForReview }

/** Store the recipe's photos (still data URLs from the download) as photo
 * docs, as the editor does on Save, then the recipe — for review. */
async function saveImport(seed: RecipeSeed, householdId: string, uid: string, note: string | null): Promise<string> {
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
  return kitchenStore.saveForReview({ ...seed, steps, cover }, householdId, { uid, name: importerName }, note)
}

/** What a link import couldn't bring, for the reviewer. */
function photoNote(link: LinkReport | undefined, withoutPhotos = false): string | null {
  if (withoutPhotos) return 'Saved without its photos, as you chose — add your own with Edit.'
  if (link?.photosUnavailable) return 'The site wouldn’t let us fetch its photos — add your own with Edit.'
  const p = link?.photos
  if (p && p.wanted > 0 && p.got === 0) return 'None of its photos came through — add your own with Edit.'
  if (p && p.got < p.wanted) return `${p.got} of ${p.wanted} photos came through — the rest took too long.`
  return null
}

function readyNote(slug: string, title: string): void {
  showAppNote({ text: 'Ready for review', title, action: { label: 'Review', path: `/review/${slug}` }, hideOn: '/add' })
}

/** Run an import here, in the app. */
async function runLocal(start: LocalJob): Promise<void> {
  let job = start
  const set = (patch: Partial<LocalJob>) => {
    job = { ...job, ...patch }
    // Removed meanwhile (the cook tapped ✕): stays removed.
    if (snapshot.jobs.some((j) => j.id === job.id)) publish({ jobs: snapshot.jobs.map((j) => (j.id === job.id ? job : j)) })
  }
  set({ status: 'working', progress: { stage: 'starting' }, error: undefined })
  try {
    const user = auth.currentUser
    if (!user) throw new Error('Sign in first.')
    const input = job.input
    const onStage = (stage: ImportStage) => set({ progress: stage })
    let seed: RecipeSeed
    let note: string | null = null
    if ('url' in input) {
      if (!aiImportConfigured) {
        seed = (await importRecipeFromUrl(input.url)).seed
      } else {
        const { answer, token } = await askWorker(input, onStage)
        const result = await finishLinkImport(answer, input.url, token, (got, wanted) => set({ progress: { stage: 'photos', got, wanted } }))
        seed = result.seed
        note = photoNote(result.link)
      }
    } else if ('text' in input) {
      try {
        if (!aiImportConfigured) throw new Error('Paste a recipe with “Ingredients” and “Directions” headings.')
        seed = seedFromAnswer((await askWorker(input, onStage)).answer, input).seed
      } catch (aiErr) {
        // The recipe reader is unreachable (offline, say): this phone's own
        // reader handles text with clear headings — and the reviewer is told.
        try {
          seed = importRecipeFromText(input.text).seed
          if (aiImportConfigured) note = 'Read on this phone (the recipe reader was unavailable) — check the ingredients and steps.'
        } catch {
          throw aiErr
        }
      }
    } else {
      seed = seedFromAnswer((await askWorker(input, onStage)).answer, input).seed
    }
    if (!snapshot.jobs.some((j) => j.id === job.id)) return
    set({ progress: { stage: 'saving' } })
    const slug = await saveImport(seed, job.householdId, user.uid, note)
    removeLocal(job.id)
    readyNote(slug, seed.title)
  } catch (cause) {
    set({ status: 'failed', error: cause instanceof Error ? cause.message : 'Couldn’t read that recipe.' })
  }
}

/** Save a queued import that has finished: its photos, then the recipe. */
async function collect(item: QueueItem): Promise<void> {
  const user = auth.currentUser
  if (!user) return
  const taken = await callWorker('queue/take', { id: item.id }).catch(() => null)
  // Offline, another of the cook's devices is saving it, or it isn't ready.
  if (taken?.status !== 200) return
  const answer = taken.data.result as WorkerAnswer
  const progress = (p?: ImportProgress) => {
    const saving = { ...snapshot.saving }
    if (p) saving[item.id] = p
    else delete saving[item.id]
    publish({ saving })
  }
  try {
    let seed: RecipeSeed
    let note: string | null = null
    let photos: { got: number; wanted: number } | undefined
    if (item.kind === 'text') {
      seed = seedFromAnswer(answer, { text: typeof taken.data.text === 'string' ? taken.data.text : '' }).seed
    } else {
      progress({ stage: 'photos', got: 0, wanted: 0 })
      const result = await finishLinkImport(answer, item.url ?? '', await user.getIdToken(), (got, wanted) =>
        progress({ stage: 'photos', got, wanted }),
      )
      photos = result.link?.photos
      // The owner's rule: a queued recipe keeps trying for its photos (the
      // Worker imports it again later) unless the cook chose to save it without.
      if (!item.withoutPhotos && photos && photos.wanted > 0 && photos.got === 0) {
        await callWorker('queue/photos-failed', { id: item.id })
        return
      }
      seed = result.seed
      note = photoNote(result.link, item.withoutPhotos)
    }
    progress({ stage: 'saving' })
    const slug = await saveImport(seed, item.householdId, user.uid, note)
    // It's in review now (and listed there) — out of the in-progress list at once.
    publish({ items: snapshot.items.map((it) => (it.id === item.id ? { ...it, status: 'saved', slug } : it)) })
    await callWorker('queue/done', { id: item.id, slug, title: seed.title, photos })
    readyNote(slug, seed.title)
  } catch (cause) {
    const denied = (cause as { code?: string }).code === 'permission-denied'
    await callWorker('queue/save-failed', {
      id: item.id,
      message: denied
        ? 'Couldn’t save it to that kitchen — you may no longer be a member.'
        : cause instanceof Error
          ? cause.message
          : 'Couldn’t save it to your kitchen.',
    }).catch(() => undefined)
  } finally {
    progress(undefined)
  }
}

// ---- Keeping up to date --------------------------------------------------------

let ticking = false
let collecting = false
let timer: ReturnType<typeof setTimeout> | undefined

/** Check again soon while anything is in motion — every couple of seconds
 * while an import runs (for its progress), else when the next retry is due;
 * nothing while the app is in the background (the Worker carries on, and
 * says so with a notification when one's ready). */
function scheduleRefresh(soon = false): void {
  clearTimeout(timer)
  if (document.visibilityState !== 'visible') return
  const now = Date.now()
  const active = snapshot.items.filter((it) => ['waiting', 'working', 'ready', 'saving'].includes(it.status))
  if (!active.length && !soon) return
  const busy = soon || active.some((it) => it.status !== 'waiting' || it.nextAt <= now + 3_000)
  const nextDue = Math.min(...active.filter((it) => it.status === 'waiting').map((it) => it.nextAt))
  const wait = busy ? 2_000 : Math.max(2_000, Math.min(60_000, nextDue - now + 1_500))
  timer = setTimeout(() => void tick(), wait)
}

/** Refresh the list and save whatever has finished (one at a time). */
export async function tick(): Promise<void> {
  if (ticking) return
  ticking = true
  try {
    await refreshQueue()
    const next = !collecting && snapshot.items.find((it) => it.status === 'ready')
    if (next) {
      collecting = true
      void collect(next).finally(() => {
        collecting = false
        void tick()
      })
    }
  } finally {
    ticking = false
    scheduleRefresh()
  }
}

/** Started once, by the app shell: check on open, when the app comes back to
 * the front, and as often as what's in motion needs. */
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
