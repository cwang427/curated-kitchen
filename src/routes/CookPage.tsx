import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { useRecipe } from '../data/recipes'
import { formatIngredient, formatStepQuantity, parseStepText } from '../lib/quantity'
import type { Ingredient, Step } from '../lib/types'

/* ---------------------------------------------------------------- *
 * Cook mode
 *
 * A full-screen, one-step-at-a-time view for actually cooking: big text, big
 * targets (hands are wet or full), the screen kept awake, and timers that keep
 * running in a tray as you move between steps — because you start a simmer on
 * step 4 and then go prep step 5 while it runs.
 * ---------------------------------------------------------------- */

interface ActiveTimer {
  id: string
  label: string
  total: number
  /** Seconds left when paused; while running, derived from `endsAt`. */
  remaining: number
  /** Epoch ms the timer will hit zero, or null when paused. */
  endsAt: number | null
  done: boolean
  /** stepId:label — lets a step show "running" instead of a second Start. */
  source: string
}

function clock(seconds: number): string {
  const s = Math.max(0, Math.round(seconds))
  const m = Math.floor(s / 60)
  const rem = s % 60
  return `${m}:${rem.toString().padStart(2, '0')}`
}

/** A short beep via Web Audio; the context is unlocked by the tap that starts a timer. */
function useAlarm() {
  const ctxRef = useRef<AudioContext | null>(null)

  const unlock = useCallback(() => {
    if (!ctxRef.current) {
      const Ctor =
        window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
      if (Ctor) ctxRef.current = new Ctor()
    }
    void ctxRef.current?.resume()
  }, [])

  const ring = useCallback(() => {
    const ctx = ctxRef.current
    if (ctx) {
      void ctx.resume()
      // Three rising beeps.
      ;[0, 0.3, 0.6].forEach((offset, i) => {
        const osc = ctx.createOscillator()
        const gain = ctx.createGain()
        osc.frequency.value = 660 + i * 220
        osc.connect(gain)
        gain.connect(ctx.destination)
        const t = ctx.currentTime + offset
        gain.gain.setValueAtTime(0.0001, t)
        gain.gain.exponentialRampToValueAtTime(0.3, t + 0.02)
        gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.25)
        osc.start(t)
        osc.stop(t + 0.26)
      })
    }
    // No-op on iOS (unsupported), a nudge everywhere else.
    navigator.vibrate?.([200, 100, 200])
  }, [])

  return { unlock, ring }
}

/** Keep the screen awake while cooking; re-acquire when the app returns to foreground. */
function useWakeLock() {
  useEffect(() => {
    let sentinel: WakeLockSentinel | null = null
    let released = false

    const acquire = async () => {
      if (!('wakeLock' in navigator)) return
      try {
        sentinel = await navigator.wakeLock.request('screen')
      } catch {
        // Denied (e.g. low battery) — cooking still works, the screen may dim.
      }
    }

    const onVisible = () => {
      if (document.visibilityState === 'visible' && !released) void acquire()
    }

    void acquire()
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      released = true
      document.removeEventListener('visibilitychange', onVisible)
      void sentinel?.release().catch(() => {})
    }
  }, [])
}

function TimerTray({
  timers,
  onToggle,
  onReset,
  onDismiss,
}: {
  timers: ActiveTimer[]
  onToggle: (id: string) => void
  onReset: (id: string) => void
  onDismiss: (id: string) => void
}) {
  if (timers.length === 0) return null
  return (
    <div className="space-y-2">
      {timers.map((timer) => (
        <div
          key={timer.id}
          className={`flex items-center gap-3 rounded-xl border px-3 py-2 ${
            timer.done ? 'border-accent bg-accent-soft' : 'border-line bg-card'
          } ${timer.done ? 'animate-pulse' : ''}`}
        >
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm text-ink-soft">{timer.label}</p>
            <p className="font-mono text-2xl tabular-nums">
              {timer.done ? "Time's up" : clock(timer.remaining)}
            </p>
          </div>
          {timer.done ? (
            <button
              type="button"
              onClick={() => onDismiss(timer.id)}
              className="min-h-11 rounded-full bg-accent px-4 text-sm font-semibold text-white dark:text-stone-900"
            >
              Dismiss
            </button>
          ) : (
            <>
              <button
                type="button"
                onClick={() => onReset(timer.id)}
                aria-label="Reset timer"
                className="grid size-11 place-items-center rounded-full border border-line text-ink-soft"
              >
                ↺
              </button>
              <button
                type="button"
                onClick={() => onDismiss(timer.id)}
                aria-label="Remove timer"
                className="grid size-11 place-items-center rounded-full border border-line text-ink-soft"
              >
                <svg viewBox="0 0 24 24" className="size-5" fill="none" aria-hidden="true">
                  <path d="M6 6l12 12M18 6L6 18" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                </svg>
              </button>
              <button
                type="button"
                onClick={() => onToggle(timer.id)}
                className="min-h-11 min-w-16 rounded-full bg-accent px-4 text-sm font-semibold text-white dark:text-stone-900"
              >
                {timer.endsAt ? 'Pause' : 'Start'}
              </button>
            </>
          )}
        </div>
      ))}
    </div>
  )
}

export default function CookPage() {
  const { slug } = useParams<{ slug: string }>()
  const [params] = useSearchParams()
  const navigate = useNavigate()
  const { recipe, loading } = useRecipe(slug)

  const scale = Number(params.get('x')) || 1
  const [index, setIndex] = useState(0)
  const [timers, setTimers] = useState<ActiveTimer[]>([])
  const { unlock, ring } = useAlarm()
  useWakeLock()

  const byId = useMemo(
    () => new Map((recipe?.ingredients ?? []).map((i) => [i.id, i] as const)),
    [recipe],
  )

  // Tick running timers off wall-clock time (survives background throttling),
  // and fire the alarm exactly once as each hits zero.
  useEffect(() => {
    const id = setInterval(() => {
      setTimers((prev) => {
        let changed = false
        const next = prev.map((t) => {
          if (t.endsAt === null || t.done) return t
          const remaining = Math.max(0, Math.round((t.endsAt - Date.now()) / 1000))
          if (remaining <= 0) {
            changed = true
            ring()
            return { ...t, remaining: 0, endsAt: null, done: true }
          }
          if (remaining !== t.remaining) {
            changed = true
            return { ...t, remaining }
          }
          return t
        })
        return changed ? next : prev
      })
    }, 500)
    return () => clearInterval(id)
  }, [ring])

  if (loading) {
    return <div className="grid min-h-dvh place-items-center text-ink-faint">Loading…</div>
  }
  if (!recipe) {
    return (
      <div className="grid min-h-dvh place-items-center px-6 text-center">
        <div className="space-y-3">
          <p className="font-serif text-xl">Recipe not found</p>
          <Link to="/" className="text-accent underline">
            Back to recipes
          </Link>
        </div>
      </div>
    )
  }

  const steps = recipe.steps
  const step: Step = steps[index]
  const stepIngredients = step.ingredientIds
    .map((id) => byId.get(id))
    .filter((i): i is Ingredient => i !== undefined)

  const startTimer = (label: string, seconds: number) => {
    unlock()
    const source = `${step.id}:${label}`
    setTimers((prev) => {
      // If this step's timer is already in the tray, don't duplicate it.
      if (prev.some((t) => t.source === source && !t.done)) return prev
      return [
        ...prev,
        {
          id: `${source}:${Date.now()}`,
          label: `${label} · ${recipe.title}`,
          total: seconds,
          remaining: seconds,
          endsAt: Date.now() + seconds * 1000,
          done: false,
          source,
        },
      ]
    })
  }

  const toggleTimer = (id: string) =>
    setTimers((prev) =>
      prev.map((t) => {
        if (t.id !== id) return t
        return t.endsAt
          ? { ...t, endsAt: null, remaining: Math.max(0, Math.round((t.endsAt - Date.now()) / 1000)) }
          : { ...t, endsAt: Date.now() + t.remaining * 1000 }
      }),
    )

  const resetTimer = (id: string) =>
    setTimers((prev) =>
      prev.map((t) => (t.id === id ? { ...t, remaining: t.total, endsAt: null, done: false } : t)),
    )

  const dismissTimer = (id: string) => setTimers((prev) => prev.filter((t) => t.id !== id))

  const isFirst = index === 0
  const isLast = index === steps.length - 1
  const activeTimerRunning = timers.some((t) => t.endsAt !== null && !t.done)

  return (
    <div className="flex min-h-dvh flex-col bg-paper">
      {/* Top: exit + progress + timer tray */}
      <div className="pad-safe-top sticky top-0 z-10 space-y-3 border-b border-line bg-paper/95 px-4 pb-3 backdrop-blur">
        <div className="mx-auto flex max-w-2xl items-center gap-3">
          <Link
            to={`/r/${recipe.slug}`}
            aria-label="Exit cook mode"
            className="grid size-10 shrink-0 place-items-center rounded-full text-ink-soft transition active:bg-line"
          >
            <svg viewBox="0 0 24 24" className="size-6" fill="none" aria-hidden="true">
              <path
                d="M6 6l12 12M18 6L6 18"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
              />
            </svg>
          </Link>
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium">{recipe.title}</p>
            <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-line">
              <div
                className="h-full rounded-full bg-accent transition-all"
                style={{ width: `${((index + 1) / steps.length) * 100}%` }}
              />
            </div>
          </div>
          <span className="shrink-0 text-sm tabular-nums text-ink-faint">
            {index + 1}/{steps.length}
          </span>
        </div>

        {timers.length > 0 && (
          <div className="mx-auto max-w-2xl">
            <TimerTray
              timers={timers}
              onToggle={toggleTimer}
              onReset={resetTimer}
              onDismiss={dismissTimer}
            />
          </div>
        )}
      </div>

      {/* Middle: the current step */}
      <main className="mx-auto w-full max-w-2xl flex-1 px-5 py-6">
        {step.group && (
          <p className="mb-2 text-sm font-semibold uppercase tracking-wide text-ink-faint">
            {step.group}
          </p>
        )}

        <p className="text-2xl leading-relaxed">
          {parseStepText(step.text).map((seg, i) =>
            seg.type === 'text' ? (
              <span key={i}>{seg.value}</span>
            ) : (
              <strong key={i} className="font-semibold text-accent tabular-nums">
                {formatStepQuantity(seg, scale)}
              </strong>
            ),
          )}
        </p>

        {stepIngredients.length > 0 && (
          <div className="mt-6">
            <p className="mb-2 text-sm font-medium text-ink-faint">What you need</p>
            <ul className="space-y-1.5">
              {stepIngredients.map((ingredient) => {
                const f = formatIngredient(ingredient, scale)
                return (
                  <li key={ingredient.id} className="text-lg">
                    <span className="font-medium tabular-nums">
                      {[f.quantity, f.unit].filter(Boolean).join(' ')}
                    </span>{' '}
                    {f.item}
                    {f.prep && <span className="text-ink-soft">, {f.prep}</span>}
                  </li>
                )
              })}
            </ul>
          </div>
        )}

        {step.temperature && (
          <p className="mt-6 inline-block rounded-full border border-line px-4 py-2 text-lg">
            🌡 {step.temperature.value}°{step.temperature.unit}
            {step.temperature.mode !== 'other' && ` ${step.temperature.mode}`}
          </p>
        )}

        {step.timers.length > 0 && (
          <div className="mt-6 flex flex-wrap gap-2">
            {step.timers.map((timer) => {
              const running = timers.some((t) => t.source === `${step.id}:${timer.label}` && !t.done)
              return (
                <button
                  key={timer.label}
                  type="button"
                  onClick={() => startTimer(timer.label, timer.seconds)}
                  disabled={running}
                  className="min-h-14 rounded-2xl bg-accent px-5 text-lg font-semibold text-white transition active:scale-[0.98] disabled:opacity-50 dark:text-stone-900"
                >
                  {running ? `${timer.label} running…` : `⏱ Start ${timer.label} (${clock(timer.seconds)})`}
                </button>
              )
            })}
          </div>
        )}
      </main>

      {/* Bottom: big navigation */}
      <div className="pad-safe-bottom sticky bottom-0 border-t border-line bg-paper/95 px-4 pt-3 backdrop-blur">
        <div className="mx-auto flex max-w-2xl gap-3">
          <button
            type="button"
            onClick={() => setIndex((i) => Math.max(0, i - 1))}
            disabled={isFirst}
            className="grid h-20 flex-1 place-items-center rounded-2xl border border-line text-lg font-semibold text-ink-soft transition active:scale-[0.98] disabled:opacity-30"
          >
            <span className="flex items-center gap-2">
              <svg viewBox="0 0 24 24" className="size-7" fill="none" aria-hidden="true">
                <path d="M15 19l-7-7 7-7" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              Back
            </span>
          </button>

          {isLast ? (
            <button
              type="button"
              onClick={() => navigate(`/r/${recipe.slug}`)}
              className="grid h-20 flex-[1.4] place-items-center rounded-2xl bg-check text-xl font-bold text-white transition active:scale-[0.98]"
            >
              {activeTimerRunning ? 'Finish (timers still running)' : 'Finish ✓'}
            </button>
          ) : (
            <button
              type="button"
              onClick={() => setIndex((i) => Math.min(steps.length - 1, i + 1))}
              className="grid h-20 flex-[1.4] place-items-center rounded-2xl bg-accent text-xl font-bold text-white transition active:scale-[0.98] dark:text-stone-900"
            >
              <span className="flex items-center gap-2">
                Next
                <svg viewBox="0 0 24 24" className="size-7" fill="none" aria-hidden="true">
                  <path d="M9 5l7 7-7 7" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </span>
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
