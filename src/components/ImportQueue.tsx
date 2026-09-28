import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { useLocation } from 'react-router-dom'
import { useAppNav } from './nav'
import {
  onQueueSaved,
  removeFromQueue,
  retryQueued,
  saveQueuedWithoutPhotos,
  startImportQueue,
  useImportQueue,
  type QueueItem,
  type SavedNote,
} from '../data/importQueue'

/** "www.seriouseats.com/the-best-corn-chowder-recipe" → "seriouseats.com › the-best-corn-chowder-recipe" */
function shortLink(url: string): string {
  try {
    const { hostname, pathname } = new URL(url)
    const last = pathname.split('/').filter(Boolean).pop() ?? ''
    return `${hostname.replace(/^www\./, '')}${last ? ` › ${decodeURIComponent(last)}` : ''}`
  } catch {
    return url
  }
}

function whenText(ms: number): string {
  if (ms <= 30_000) return 'shortly'
  const min = Math.round(ms / 60_000)
  return min < 60 ? `in ${Math.max(1, min)} min` : `in about ${Math.round(min / 60)} h`
}

function statusText(item: QueueItem, now: number): string {
  switch (item.status) {
    case 'waiting':
      if (!item.attempts && item.nextAt <= now) return 'Starting…'
      return `${item.note ?? 'Waiting'} — trying again ${whenText(item.nextAt - now)}`
    case 'working':
      return 'Importing now…'
    case 'ready':
    case 'saving':
      return 'Imported — saving to your kitchen…'
    case 'saved': {
      const p = item.photos
      return `Saved to your kitchen${p && p.wanted > 0 && p.got < p.wanted ? ` · ${p.got} of ${p.wanted} photos came through` : ''}`
    }
    case 'photos-unavailable':
      return item.note ?? 'The recipe came through, but its photos never did'
    case 'failed':
      return item.note ?? 'Couldn’t import it'
  }
}

/**
 * The cook's queued links and how each is going: waiting (and why), importing,
 * saved (tap Open), or needing a decision. Shown on the Add a recipe screens.
 */
export function ImportQueueList() {
  const { items, available } = useImportQueue()
  const { goTo } = useAppNav()
  const [busy, setBusy] = useState<string | null>(null)
  // Re-render now and then so "trying again in 4 min" counts down; the clock
  // itself is read fresh each render (a new item must not look overdue).
  const [, setTick] = useState(0)
  useEffect(() => {
    const id = setInterval(() => setTick((n) => n + 1), 15_000)
    return () => clearInterval(id)
  }, [])
  const now = Date.now()
  if (!available || !items.length) return null

  const act = async (id: string, fn: (id: string) => Promise<void>) => {
    setBusy(id)
    try {
      await fn(id)
    } finally {
      setBusy(null)
    }
  }
  const newestFirst = [...items].sort((a, b) => b.addedAt - a.addedAt)
  return (
    <section aria-label="Import queue" className="space-y-2 pt-2">
      <h2 className="text-xs font-semibold uppercase tracking-wide text-ink-faint">Import queue</h2>
      <p className="text-sm text-ink-soft">
        We keep trying these for up to a day — even with the app closed — and save each to your kitchen when it comes
        through.
      </p>
      {newestFirst.map((item) => (
        <div key={item.id} className="rounded-2xl border border-line bg-card p-3">
          <div className="flex items-start gap-2">
            <div className="min-w-0 flex-1 pt-1">
              <p className="truncate font-medium text-ink">{item.title ?? shortLink(item.url)}</p>
              <p className={`text-sm ${item.status === 'failed' ? 'text-red-600 dark:text-red-400' : 'text-ink-soft'}`}>
                {statusText(item, now)}
              </p>
            </div>
            <button
              type="button"
              aria-label={item.status === 'saved' ? 'Dismiss' : 'Remove from queue'}
              disabled={busy === item.id}
              onClick={() => void act(item.id, removeFromQueue)}
              className="grid h-11 w-11 shrink-0 place-items-center rounded-full text-xl text-ink-faint transition active:scale-95 disabled:opacity-50"
            >
              ✕
            </button>
          </div>
          {item.status === 'saved' && item.slug && (
            <button
              type="button"
              onClick={() => goTo(`/r/${item.slug}`)}
              className="mt-2 grid h-11 w-full place-items-center rounded-xl border border-line text-base font-medium text-ink"
            >
              Open recipe
            </button>
          )}
          {item.status === 'photos-unavailable' && (
            <button
              type="button"
              disabled={busy === item.id}
              onClick={() => void act(item.id, saveQueuedWithoutPhotos)}
              className="mt-2 grid h-11 w-full place-items-center rounded-xl bg-accent text-base font-semibold text-white disabled:opacity-60 dark:text-stone-900"
            >
              Save without photos
            </button>
          )}
          {item.status === 'failed' && !item.final && (
            <button
              type="button"
              disabled={busy === item.id}
              onClick={() => void act(item.id, retryQueued)}
              className="mt-2 grid h-11 w-full place-items-center rounded-xl border border-line text-base font-medium text-ink disabled:opacity-60"
            >
              Try again
            </button>
          )}
        </div>
      ))}
    </section>
  )
}

/**
 * Mounted once by the app: saves queued imports as they finish, and says so
 * with a short note at the bottom of the screen (not over cook mode).
 */
export function ImportQueueRunner() {
  const [note, setNote] = useState<SavedNote | null>(null)
  const { goTo } = useAppNav()
  const { pathname } = useLocation()
  useEffect(() => startImportQueue(), [])
  useEffect(() => {
    onQueueSaved(setNote)
    return () => onQueueSaved(null)
  }, [])
  useEffect(() => {
    if (!note) return
    const id = setTimeout(() => setNote(null), 8_000)
    return () => clearTimeout(id)
  }, [note])
  if (!note || pathname.endsWith('/cook')) return null
  return createPortal(
    <div className="pad-safe-bottom fixed inset-x-0 bottom-0 z-40 px-4 pt-2">
      <div
        role="status"
        className="mx-auto mb-3 flex max-w-md items-center gap-2 rounded-2xl border border-line bg-card p-3 shadow-lg"
      >
        <p className="min-w-0 flex-1 text-sm text-ink">
          Added to your kitchen: <span className="font-semibold">{note.title}</span>
        </p>
        <button
          type="button"
          onClick={() => {
            setNote(null)
            goTo(`/r/${note.slug}`)
          }}
          className="h-11 shrink-0 rounded-xl bg-accent px-4 text-base font-semibold text-white dark:text-stone-900"
        >
          Open
        </button>
        <button
          type="button"
          aria-label="Dismiss"
          onClick={() => setNote(null)}
          className="grid h-11 w-11 shrink-0 place-items-center rounded-full text-xl text-ink-faint"
        >
          ✕
        </button>
      </div>
    </div>,
    document.body,
  )
}
