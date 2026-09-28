import type { CookDish, CookSession, SyncTimer } from './types'

/**
 * The kitchen timers running on this phone, as notifications to send when
 * they ring (worker/src/notify.ts sends them, so they arrive with the app
 * closed) and as lines for the "timers running" note. Pure, for test:cook.
 */

export interface TimerAlert {
  id: string
  /** When it rings (this phone's clock, ms). */
  at: number
  /** "Simmer is done" */
  title: string
  /** "Corn chowder · step 3" */
  body: string
  /** "Simmer · Corn chowder, step 3 — rings 6:42 PM" */
  line: string
  /** Cook mode for that dish, relative to the app ("r/corn-chowder/cook"). */
  path: string
}

/** A timer's label reads "Simmer · Corn chowder" (see CookPage's startTimer). */
function describe(timer: SyncTimer, dish: string): { name: string; where: string } {
  const [name, ...rest] = timer.label.split(' · ')
  const title = rest.join(' · ') || dish
  return { name: name.trim() || 'Timer', where: timer.step ? `${title} · step ${timer.step}` : title }
}

export function clockTime(at: number): string {
  return new Date(at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
}

/** Every running timer (on the cook board, and in a cook-together session),
 * soonest first. Paused and finished ones aren't running. */
export function timerAlerts(dishes: CookDish[], session: CookSession | null, now: number): TimerAlert[] {
  const out = new Map<string, TimerAlert>()
  const add = (timer: SyncTimer, dish: string, slug: string) => {
    if (timer.endsAt === null || timer.endsAt <= now) return
    const { name, where } = describe(timer, dish)
    out.set(timer.id, {
      id: timer.id,
      at: timer.endsAt,
      title: `${name} is done`,
      body: where,
      line: `${name} · ${where.replace(' · step', ', step')} — rings ${clockTime(timer.endsAt)}`,
      path: `r/${slug}/cook`,
    })
  }
  for (const dish of dishes) for (const t of dish.timers) add(t, dish.title, dish.slug)
  if (session?.active) for (const t of session.timers) add(t, session.recipeTitle, session.recipeSlug)
  return [...out.values()].sort((a, b) => a.at - b.at)
}

/** The "timers running" note: a title and one line per timer. */
export function runningNote(alerts: TimerAlert[]): { title: string; body: string } | null {
  if (!alerts.length) return null
  return {
    title: alerts.length === 1 ? '1 timer running' : `${alerts.length} timers running`,
    body: alerts.map((a) => a.line).join('\n'),
  }
}
