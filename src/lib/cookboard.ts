import type { CookDish, SyncTimer } from './types'

/**
 * The "cooking now" timeline model: turn a board of concurrent dishes into a
 * glanceable strip and a merged, time-sorted "Up next" list. Pure and DOM-free
 * (like the rest of src/lib), so it's unit-tested and runs under Node.
 *
 * The honest constraint: this reads only what a live cook actually knows — where
 * you are in each dish, and its running timers (which carry a real wall-clock end
 * time, `endsAt`). It does NOT invent per-step durations, so it can't predict the
 * *future* shape of steps you haven't reached ("start the beans in 18 min"). What
 * it can say truthfully: which dishes have nothing counting down and so need you
 * now, and exactly when each running timer will ring. A back-timed "ready by 6:45"
 * scheduler is a later phase that needs per-step durations added to the schema.
 */

/** A timer with `endsAt` set (running), its countdown filled in for `now`. */
export interface RunningTimer {
  id: string
  label: string
  endsAt: number
  secondsLeft: number
  /** Reached zero — it's ringing and needs acknowledging. */
  done: boolean
}

/** A dish's live state, derived for a given `now`. */
export interface DishStatus {
  slug: string
  title: string
  scale: number
  stepIndex: number
  /** Running timers (endsAt set), soonest end first; includes ones that rang. */
  running: RunningTimer[]
  /**
   * Nothing is actively counting down (no timer, all paused, or one rang), so
   * this dish is what you should be hands-on with — not waiting on a clock.
   */
  attention: boolean
  /** Soonest end among still-running (not rung) timers, else null. */
  soonestEndsAt: number | null
}

export type AgendaKind = 'now' | 'timer'

/** One row of the merged "Up next" list across all dishes. */
export interface AgendaItem {
  key: string
  dishSlug: string
  dishTitle: string
  /** 'now' = do it now (rung timer or a hands-on dish); 'timer' = a ring coming up. */
  kind: AgendaKind
  /** The timer's label; '' for a plain hands-on "now" item. */
  label: string
  /** A rung timer awaiting acknowledgement. */
  done: boolean
  /** Absolute epoch ms it's due, or null for "now". */
  endsAt: number | null
  /** Seconds until due, or null for "now". */
  secondsUntil: number | null
}

export interface Timeline {
  now: number
  /**
   * How far the strip needs to reach: the latest still-running timer end,
   * relative to now (ms). Null when nothing is counting down — then the strip
   * has no future to draw and the page shows the agenda alone.
   */
  horizonMs: number | null
  statuses: DishStatus[]
  agenda: AgendaItem[]
}

function runningOf(timer: SyncTimer, now: number): RunningTimer | null {
  if (timer.endsAt === null) return null
  const secondsLeft = Math.max(0, Math.round((timer.endsAt - now) / 1000))
  return { id: timer.id, label: timer.label, endsAt: timer.endsAt, secondsLeft, done: secondsLeft <= 0 }
}

/** Build the timeline model for a board of dishes at a moment in time. */
export function buildTimeline(dishes: CookDish[], now: number): Timeline {
  const statuses: DishStatus[] = dishes.map((dish) => {
    const running = dish.timers
      .map((t) => runningOf(t, now))
      .filter((t): t is RunningTimer => t !== null)
      .sort((a, b) => a.endsAt - b.endsAt)
    const live = running.filter((t) => !t.done)
    const rang = running.length > live.length
    return {
      slug: dish.slug,
      title: dish.title,
      scale: dish.scale,
      stepIndex: dish.stepIndex,
      running,
      // Needs you now when nothing is counting down, or a timer has rung and is
      // waiting to be acknowledged — even if another is still running.
      attention: live.length === 0 || rang,
      soonestEndsAt: live.length > 0 ? live[0].endsAt : null,
    }
  })

  let horizonMs: number | null = null
  for (const s of statuses) {
    for (const t of s.running) {
      if (!t.done) horizonMs = Math.max(horizonMs ?? 0, t.endsAt - now)
    }
  }

  // Two buckets: things that need you now (rung timers, then hands-on dishes),
  // and upcoming rings sorted by soonest. Rung timers sort ahead of hands-on so
  // the most urgent thing — a timer that's already going off — is at the top.
  const nowItems: AgendaItem[] = []
  const timerItems: AgendaItem[] = []

  for (const s of statuses) {
    const done = s.running.filter((t) => t.done)
    const live = s.running.filter((t) => !t.done)

    if (done.length > 0) {
      for (const t of done) {
        nowItems.push({
          key: `${s.slug}:done:${t.id}`,
          dishSlug: s.slug,
          dishTitle: s.title,
          kind: 'now',
          label: t.label,
          done: true,
          endsAt: t.endsAt,
          secondsUntil: 0,
        })
      }
    } else if (live.length === 0) {
      // No timer counting down — you're hands-on with this one now.
      nowItems.push({
        key: `${s.slug}:hands`,
        dishSlug: s.slug,
        dishTitle: s.title,
        kind: 'now',
        label: '',
        done: false,
        endsAt: null,
        secondsUntil: null,
      })
    }

    for (const t of live) {
      timerItems.push({
        key: `${s.slug}:timer:${t.id}`,
        dishSlug: s.slug,
        dishTitle: s.title,
        kind: 'timer',
        label: t.label,
        done: false,
        endsAt: t.endsAt,
        secondsUntil: t.secondsLeft,
      })
    }
  }

  // Stable: rung timers first, hands-on next, each keeping board order.
  const rung = nowItems.filter((i) => i.done)
  const hands = nowItems.filter((i) => !i.done)
  timerItems.sort((a, b) => (a.endsAt ?? 0) - (b.endsAt ?? 0))

  return { now, horizonMs, statuses, agenda: [...rung, ...hands, ...timerItems] }
}
