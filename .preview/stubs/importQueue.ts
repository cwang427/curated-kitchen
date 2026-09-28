import { useEffect, useState } from 'react'
import type { ImportProgress } from '../../src/lib/importStage'

/** Preview: in-memory imports. Open /add?queuedemo to start with one in every
 * state; Import on any screen adds one that runs through the stages. */

type Stage = Extract<ImportProgress, { stage: 'opening' | 'another-way' | 'reading' | 'writing' | 'finishing' }>
export type QueueStatus = 'waiting' | 'working' | 'ready' | 'saving' | 'photos-unavailable' | 'failed' | 'saved'
export interface QueueItem {
  id: string
  kind?: 'link' | 'text'
  url?: string
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
  final?: boolean
  stage?: Stage
  hasText?: boolean
}
export interface LocalJob {
  id: string
  kind: 'link' | 'text' | 'photos'
  input: unknown
  householdId: string
  name: string
  addedAt: number
  status: 'working' | 'failed'
  progress: ImportProgress
  error?: string
}
export type AppNote = { text: string; title: string; action: { label: string; path: string }; hideOn?: string }
export type NewImport = { url: string } | { text: string } | { images: unknown[]; name: string }

const now = Date.now()
const demo = typeof location !== 'undefined' && location.search.includes('queuedemo')
const demoItems: QueueItem[] = [
  { id: 'c', kind: 'link', url: 'https://www.bonappetit.com/recipe/crispy-rice-salad', householdId: 'h', addedAt: now - 3 * 60_000, status: 'working', attempts: 1, nextAt: now, stage: { stage: 'writing', ingredients: 9, steps: 2 } },
  { id: 'r', kind: 'link', url: 'https://www.seriouseats.com/the-best-corn-chowder-recipe', householdId: 'h', addedAt: now - 4 * 60_000, status: 'saving', attempts: 1, nextAt: now, title: 'The Best Corn Chowder' },
  { id: 'b', kind: 'link', url: 'https://www.seriouseats.com/pressure-cooker-ragu-bolognese', householdId: 'h', addedAt: now - 5 * 60_000, status: 'waiting', attempts: 3, nextAt: now + 9 * 60_000, note: 'The recipe reader was busy' },
  { id: 'h', kind: 'link', url: 'https://www.seriouseats.com/sichuan-dry-fried-green-beans', householdId: 'h', addedAt: now - 6 * 60_000, status: 'waiting', attempts: 2, nextAt: now + 4 * 60_000, hasText: true, title: 'Sichuan Dry-Fried Green Beans', note: 'Got the recipe, but not its photos yet' },
  { id: 'e', kind: 'link', url: 'https://cooking.nytimes.com/recipes/1017518-panzanella', householdId: 'h', addedAt: now - 7 * 60_000, status: 'failed', final: true, attempts: 1, nextAt: now, note: 'NYT Cooking recipes are for subscribers only, so the app can’t open the link — copy the recipe text (or take a screenshot) and add it that way.' },
]
const demoJobs: LocalJob[] = [
  { id: 'p', kind: 'photos', input: {}, householdId: 'h', name: '3 recipe photos', addedAt: now - 60_000, status: 'working', progress: { stage: 'reading' } },
]
let snapshot = {
  items: demo ? demoItems : ([] as QueueItem[]),
  available: true as boolean | null,
  jobs: demo ? demoJobs : ([] as LocalJob[]),
  saving: (demo ? { r: { stage: 'photos', got: 3, wanted: 7 } } : {}) as Record<string, ImportProgress>,
}
const listeners = new Set<() => void>()
const publish = (next: Partial<typeof snapshot>) => {
  snapshot = { ...snapshot, ...next }
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
export async function callWorker(): Promise<{ status: number; data: Record<string, unknown> }> {
  return { status: 200, data: { publicKey: 'BPreview', result: 'sent' } }
}
export async function refreshQueue() {}
export function shortLink(url: string): string {
  try {
    const { hostname, pathname } = new URL(url)
    const last = pathname.split('/').filter(Boolean).pop() ?? ''
    return `${hostname.replace(/^www\./, '')}${last ? ` › ${decodeURIComponent(last)}` : ''}`
  } catch {
    return url
  }
}

/** A new import walks through the stages, a second or so each. */
export async function startImport(job: NewImport) {
  const id = String(Math.random())
  const url = 'url' in job ? job.url : undefined
  const item: QueueItem = { id, kind: url ? 'link' : 'text', url, label: 'text' in job ? job.text.split('\n')[0] : undefined, householdId: 'h', addedAt: Date.now(), status: 'waiting', attempts: 0, nextAt: Date.now() }
  publish({ items: [...snapshot.items, item] })
  const stages: Stage[] = [
    { stage: 'opening', host: url ? new URL(url).hostname.replace(/^www\./, '') : 'recipe' },
    { stage: 'reading' },
    { stage: 'writing', ingredients: 4, steps: 0 },
    { stage: 'writing', ingredients: 11, steps: 3 },
    { stage: 'finishing' },
  ]
  stages.forEach((stage, i) =>
    setTimeout(() => publish({ items: snapshot.items.map((it) => (it.id === id ? { ...it, status: 'working', stage } : it)) }), 900 * (i + 1)),
  )
}
export async function removeFromQueue(id: string) {
  publish({ items: snapshot.items.filter((it) => it.id !== id) })
}
export async function retryQueued(id: string) {
  publish({ items: snapshot.items.map((it) => (it.id === id ? { ...it, status: 'waiting' as const, attempts: 0, nextAt: Date.now(), note: 'Trying again' } : it)) })
}
export async function saveQueuedWithoutPhotos(id: string) {
  publish({ items: snapshot.items.map((it) => (it.id === id ? { ...it, status: 'saving' as const } : it)) })
}
export function removeLocal(id: string) {
  publish({ jobs: snapshot.jobs.filter((j) => j.id !== id) })
}
export function retryLocal() {}

let note: ((n: AppNote) => void) | null = null
export function onAppNote(l: ((n: AppNote) => void) | null) {
  note = l
  // ?queuetoast shows the "Ready for review" note.
  if (l && typeof location !== 'undefined' && location.search.includes('queuetoast')) {
    setTimeout(() => note?.({ text: 'Ready for review', title: 'The Best Corn Chowder', action: { label: 'Review', path: '/review/corn-chowder' } }), 300)
  }
}
export function showAppNote(n: AppNote) {
  note?.(n)
}
export function setImporterName() {}
export async function tick() {}
export function startImportQueue() {
  return () => {}
}
