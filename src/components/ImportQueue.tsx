import { useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { useLocation } from 'react-router-dom'
import { useAppNav } from './nav'
import { useAuth } from '../auth/AuthProvider'
import {
  onAppNote,
  removeFromQueue,
  removeLocal,
  retryLocal,
  retryQueued,
  saveQueuedWithoutPhotos,
  setImporterName,
  shortLink,
  startImportQueue,
  useImportQueue,
  type AppNote,
  type LocalJob,
  type QueueItem,
} from '../data/importQueue'
import { useReviewRecipes, watchReviews } from '../data/recipes'
import {
  clearTimerNotes,
  dismissNudge,
  enableNotifications,
  nudgeDismissed,
  refreshNotifications,
  showRunningNote,
  syncTimers,
  useNotifications,
} from '../data/notifications'
import { useCookBoard } from '../data/cookBoard'
import { useCookSession } from '../data/cooksession'
import { progressFraction, progressLine, type ImportProgress } from '../lib/importStage'
import { timerAlerts } from '../lib/timerAlerts'
import type { Recipe } from '../lib/types'

function whenText(ms: number): string {
  if (ms <= 30_000) return 'shortly'
  const min = Math.round(ms / 60_000)
  return min < 60 ? `in ${Math.max(1, min)} min` : `in about ${Math.round(min / 60)} h`
}

function agoText(at: number | null, now: number): string {
  if (!at) return ''
  const min = Math.round((now - at) / 60_000)
  if (min < 1) return 'just now'
  if (min < 60) return `${min} min ago`
  const h = Math.round(min / 60)
  if (h < 24) return `${h} h ago`
  return new Date(at).toLocaleDateString([], { month: 'short', day: 'numeric' })
}

/** One import in progress (or stuck), as the list shows it. */
type Task = {
  id: string
  name: string
  line: string
  /** The bar, while it's actually running. */
  progress: number | null
  tone: 'working' | 'waiting' | 'attention' | 'failed'
  /** Photos run on the phone: leaving the app stops them. */
  keepOpen?: boolean
  withoutPhotos?: () => Promise<void>
  retry?: () => Promise<void> | void
  remove: () => Promise<void> | void
  addedAt: number
}

function running(p: ImportProgress): Pick<Task, 'line' | 'progress' | 'tone'> {
  return { line: progressLine(p), progress: progressFraction(p), tone: 'working' }
}

function queueTask(item: QueueItem, saving: ImportProgress | undefined, now: number): Task | null {
  const name = item.title ?? (item.url ? shortLink(item.url) : (item.label ?? 'Pasted recipe'))
  const base = { id: item.id, name, addedAt: item.addedAt, remove: () => removeFromQueue(item.id) }
  switch (item.status) {
    case 'saved':
      return null // in review now — listed as a recipe
    case 'working':
      return { ...base, ...running(item.stage ?? { stage: 'starting' }) }
    case 'ready':
    case 'saving':
      return { ...base, ...running(saving ?? (item.status === 'saving' ? { stage: 'saving' } : { stage: 'finishing' })) }
    case 'waiting':
      if (!item.attempts && item.nextAt <= now + 3_000) return { ...base, ...running({ stage: 'starting' }) }
      if (item.hasText) {
        return {
          ...base,
          line: `Got the recipe — still trying for its photos. Next try ${whenText(item.nextAt - now)}.`,
          progress: null,
          tone: 'waiting',
          withoutPhotos: () => saveQueuedWithoutPhotos(item.id),
        }
      }
      return { ...base, line: `${item.note ?? 'Waiting'} — trying again ${whenText(item.nextAt - now)}.`, progress: null, tone: 'waiting' }
    case 'photos-unavailable':
      return {
        ...base,
        line: `${item.note ?? 'The recipe came through, but its photos never did'}.`,
        progress: null,
        tone: 'attention',
        withoutPhotos: () => saveQueuedWithoutPhotos(item.id),
      }
    case 'failed':
      return {
        ...base,
        line: item.note ?? 'Couldn’t import it.',
        progress: null,
        tone: 'failed',
        retry: item.final ? undefined : () => retryQueued(item.id),
      }
  }
}

function localTask(job: LocalJob): Task {
  const base = { id: job.id, name: job.name, addedAt: job.addedAt, remove: () => removeLocal(job.id) }
  if (job.status === 'failed') {
    return { ...base, line: job.error ?? 'Couldn’t read it.', progress: null, tone: 'failed', retry: () => retryLocal(job.id) }
  }
  return { ...base, ...running(job.progress), keepOpen: job.kind === 'photos' }
}

/**
 * "Recipes awaiting review", on Add a recipe: imports that have arrived (any
 * member's — tap to look one over), then the ones still on their way, with
 * how each is getting on.
 */
export function AwaitingReview() {
  const { recipes } = useReviewRecipes()
  const { items, jobs, saving } = useImportQueue()
  const { user } = useAuth()
  const { goTo } = useAppNav()
  // Re-render every few seconds so "trying again in 4 min" counts down; the
  // clock is read fresh each render (a new item must not look overdue).
  const [, setTick] = useState(0)
  useEffect(() => {
    const id = setInterval(() => setTick((n) => n + 1), 5_000)
    return () => clearInterval(id)
  }, [])
  const now = Date.now()
  const tasks = [
    ...items.map((it) => queueTask(it, saving[it.id], now)).filter((t): t is Task => t !== null),
    ...jobs.map(localTask),
  ].sort((a, b) => b.addedAt - a.addedAt)

  return (
    <section aria-labelledby="review-heading" className="space-y-3 pt-4">
      <h2 id="review-heading" className="text-sm font-semibold uppercase tracking-wide text-ink-faint">
        Recipes awaiting review
      </h2>
      {recipes.length === 0 && tasks.length === 0 && (
        <p className="text-sm text-ink-soft">
          Nothing waiting. Imported recipes land here so you can look them over before they join your kitchen.
        </p>
      )}
      {recipes.map((recipe) => (
        <ReviewCard key={recipe.id} recipe={recipe} you={recipe.review?.by === user?.uid} now={now} onOpen={() => goTo(`/review/${recipe.slug}`)} />
      ))}
      {tasks.length > 0 && <NotifyNudge where="imports" />}
      {tasks.map((task) => (
        <TaskCard key={task.id} task={task} />
      ))}
    </section>
  )
}

function ReviewCard({ recipe, you, now, onOpen }: { recipe: Recipe; you: boolean; now: number; onOpen: () => void }) {
  const by = you ? 'you' : (recipe.review?.byName ?? 'someone')
  return (
    <button
      type="button"
      onClick={onOpen}
      className="flex w-full items-center gap-3 rounded-2xl border border-accent/40 bg-card p-3 text-left transition active:scale-[0.99]"
    >
      {recipe.cover ? (
        <img src={recipe.cover.thumb} alt="" className="size-16 shrink-0 rounded-xl object-cover" />
      ) : (
        <span aria-hidden className="grid size-16 shrink-0 place-items-center rounded-xl bg-accent-soft text-2xl">
          🍽
        </span>
      )}
      <span className="min-w-0 flex-1">
        <span className="block font-medium leading-snug text-ink">{recipe.title}</span>
        <span className="mt-0.5 block text-sm text-ink-soft">
          Ready for review · imported by {by} {agoText(recipe.review?.at ?? null, now)}
        </span>
        {recipe.review?.note && <span className="mt-0.5 block text-sm text-ink-faint">{recipe.review.note}</span>}
      </span>
      <svg viewBox="0 0 24 24" className="size-5 shrink-0 text-ink-faint" fill="none" aria-hidden="true">
        <path d="M9 5l7 7-7 7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </button>
  )
}

function TaskCard({ task }: { task: Task }) {
  const [busy, setBusy] = useState(false)
  const run = async (fn: () => Promise<void> | void) => {
    setBusy(true)
    try {
      await fn()
    } finally {
      setBusy(false)
    }
  }
  const remove = () => {
    // Stopping one that's under way can't be undone — ask; a failed one just goes.
    if (task.tone !== 'failed' && !confirm(`Stop importing “${task.name}”?`)) return
    void run(task.remove)
  }
  return (
    <div className="rounded-2xl border border-line bg-card p-3">
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1 pt-1">
          <p className="truncate font-medium text-ink">{task.name}</p>
          <p
            role={task.tone === 'working' ? 'status' : undefined}
            className={`text-sm ${task.tone === 'failed' ? 'text-red-600 dark:text-red-400' : 'text-ink-soft'}`}
          >
            {task.line}
          </p>
          {task.keepOpen && <p className="text-xs text-ink-faint">Keep the app open until it’s done.</p>}
        </div>
        <button
          type="button"
          aria-label={task.tone === 'failed' ? 'Remove' : 'Stop this import'}
          disabled={busy}
          onClick={remove}
          className="grid h-11 w-11 shrink-0 place-items-center rounded-full text-xl text-ink-faint transition active:scale-95 disabled:opacity-50"
        >
          ✕
        </button>
      </div>
      {task.progress !== null && (
        <div className="mt-2 h-1.5 overflow-clip rounded-full bg-line" aria-hidden>
          <div className="h-full rounded-full bg-accent transition-[width] duration-700" style={{ width: `${Math.round(task.progress * 100)}%` }} />
        </div>
      )}
      {task.withoutPhotos && (
        <button
          type="button"
          disabled={busy}
          onClick={() => void run(task.withoutPhotos!)}
          className={`mt-2 grid h-11 w-full place-items-center rounded-xl text-base disabled:opacity-60 ${
            task.tone === 'attention' ? 'bg-accent font-semibold text-white dark:text-stone-900' : 'border border-line font-medium text-ink'
          }`}
        >
          Save without photos
        </button>
      )}
      {task.retry && (
        <button
          type="button"
          disabled={busy}
          onClick={() => void run(task.retry!)}
          className="mt-2 grid h-11 w-full place-items-center rounded-xl border border-line text-base font-medium text-ink disabled:opacity-60"
        >
          Try again
        </button>
      )}
    </div>
  )
}

/** A suggestion to turn notifications on, where they'd help: while imports
 * are under way (so you can put the phone down), and in cook mode with a
 * timer running. "Not now" hides it there for good (Settings still has it). */
export function NotifyNudge({ where }: { where: 'imports' | 'timers' }) {
  const state = useNotifications()
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  if (state.on || state.support !== 'ok' || state.blocked || nudgeDismissed(where)) return null
  const turnOn = async () => {
    setError(null)
    setBusy(true)
    try {
      await enableNotifications()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Couldn’t turn notifications on.')
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="rounded-2xl border border-line bg-card p-3">
      <p className="text-sm text-ink">
        {where === 'imports'
          ? 'Get a notification when it’s ready? You can close the app meanwhile.'
          : 'Get an alert when a timer finishes, even with the app closed?'}
      </p>
      {error && (
        <p role="alert" className="mt-1 text-sm text-red-600 dark:text-red-400">
          {error}
        </p>
      )}
      <div className="mt-2 flex gap-2">
        <button
          type="button"
          onClick={() => void turnOn()}
          disabled={busy}
          className="grid h-11 flex-1 place-items-center rounded-xl bg-accent px-3 text-base font-semibold text-white disabled:opacity-60 dark:text-stone-900"
        >
          {busy ? 'Turning on…' : 'Turn on notifications'}
        </button>
        <button
          type="button"
          onClick={() => dismissNudge(where)}
          className="grid h-11 place-items-center rounded-xl border border-line px-4 text-base font-medium text-ink-soft"
        >
          Not now
        </button>
      </div>
    </div>
  )
}

/**
 * Mounted once by the app: keeps imports moving (and saved into review as
 * they finish), keeps the review list live, keeps this phone's timers with
 * the Worker for notifications, opens the screen a tapped notification names,
 * and shows a short note at the bottom ("Ready for review: …").
 */
export function ImportRunner() {
  const { user, profile, household } = useAuth()
  const isMember = !!user && !!household && household.memberUids.includes(user.uid)
  const [note, setNote] = useState<AppNote | null>(null)
  const { goTo } = useAppNav()
  const { pathname } = useLocation()
  const notify = useNotifications()

  useEffect(() => startImportQueue(), [])
  const reviewKitchen = isMember ? household!.id : null
  useEffect(() => watchReviews(reviewKitchen), [reviewKitchen])
  useEffect(() => setImporterName(profile?.displayName ?? user?.email ?? null), [profile, user])
  useEffect(() => void refreshNotifications(), [])

  // A tapped notification, with the app already open: go where it says.
  useEffect(() => {
    if (!('serviceWorker' in navigator)) return
    const onMessage = (e: MessageEvent) => {
      const data = e.data as { type?: string; path?: string } | null
      if (data?.type === 'open' && typeof data.path === 'string') goTo(data.path === '/' ? '/' : data.path.replace(/\/+$/, ''))
    }
    navigator.serviceWorker.addEventListener('message', onMessage)
    return () => navigator.serviceWorker.removeEventListener('message', onMessage)
  }, [goTo])

  // Timers: every running one, kept with the Worker so it rings with the app
  // closed; a note listing them when you leave the app, cleared on return.
  const board = useCookBoard()
  const { session } = useCookSession(reviewKitchen)
  const alerts = useMemo(() => timerAlerts(board.dishes, session, Date.now()), [board, session])
  useEffect(() => {
    if (notify.on) syncTimers(alerts)
  }, [alerts, notify.on])
  useEffect(() => {
    const onVisibility = () => void (document.visibilityState === 'hidden' ? showRunningNote() : clearTimerNotes())
    document.addEventListener('visibilitychange', onVisibility)
    return () => document.removeEventListener('visibilitychange', onVisibility)
  }, [])

  useEffect(() => {
    onAppNote(setNote)
    return () => onAppNote(null)
  }, [])
  useEffect(() => {
    if (!note) return
    const id = setTimeout(() => setNote(null), 8_000)
    return () => clearTimeout(id)
  }, [note])
  if (!note || pathname.endsWith('/cook') || (note.hideOn && pathname === note.hideOn)) return null
  return createPortal(
    <div className="pad-safe-bottom fixed inset-x-0 bottom-0 z-40 px-4 pt-2">
      <div role="status" className="mx-auto mb-3 flex max-w-md items-center gap-2 rounded-2xl border border-line bg-card p-3 shadow-lg">
        <p className="min-w-0 flex-1 text-sm text-ink">
          {note.text}: <span className="font-semibold">{note.title}</span>
        </p>
        <button
          type="button"
          onClick={() => {
            setNote(null)
            goTo(note.action.path)
          }}
          className="h-11 shrink-0 rounded-xl bg-accent px-4 text-base font-semibold text-white dark:text-stone-900"
        >
          {note.action.label}
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
