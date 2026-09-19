import { additionFromIngredient, type Addition } from './grocery'
import type { PlanEntry, Recipe } from './types'

/**
 * Meal-plan logic: the rolling-week day window, grouping planned meals by day,
 * and turning a plan into grocery additions. Pure and DOM-free so it's testable
 * and shared between the app and scripts.
 */

/** The label a plan entry falls under when it has no day (or a day off-window). */
export const ANYTIME = 'anytime' as const

export interface PlanDay {
  /** ISO yyyy-mm-dd. */
  date: string
  /** "Today", "Tomorrow", or a weekday like "Thu". */
  label: string
  /** A short date, "Sep 20". */
  sub: string
}

/** Local-time yyyy-mm-dd for a Date — never UTC, so "today" matches the phone. */
export function isoDate(d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

/** ISO date `n` days after another ISO date (or Date). */
export function addDays(from: string | Date, n: number): string {
  const base = typeof from === 'string' ? new Date(`${from}T00:00:00`) : from
  const next = new Date(base)
  next.setDate(next.getDate() + n)
  return isoDate(next)
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/**
 * The plan's day window: a rolling run of days starting today. Rolling (not
 * Mon–Sun) because planning ahead from "now" is what a weeknight cook actually
 * does, and it never shows days already in the past.
 */
export function planWindow(today: Date, days = 7): PlanDay[] {
  const start = isoDate(today)
  return Array.from({ length: days }, (_, i) => {
    const date = addDays(start, i)
    const d = new Date(`${date}T00:00:00`)
    const label = i === 0 ? 'Today' : i === 1 ? 'Tomorrow' : WEEKDAYS[d.getDay()]
    return { date, label, sub: `${MONTHS[d.getMonth()]} ${d.getDate()}` }
  })
}

export interface GroupedPlan {
  days: Array<{ day: PlanDay; entries: PlanEntry[] }>
  /** Entries with no day, or a day outside the window (past/far future). */
  anytime: PlanEntry[]
}

/**
 * Sort entries into the day window plus an "anytime" bucket. Nothing is ever
 * dropped: an entry whose date isn't one of the window days (including past
 * dates) lands in `anytime` so it stays visible and can be re-dayed or removed.
 */
export function groupPlan(entries: PlanEntry[], window: PlanDay[]): GroupedPlan {
  const byDate = new Map<string, PlanEntry[]>(window.map((d) => [d.date, []]))
  const anytime: PlanEntry[] = []

  for (const entry of entries) {
    const bucket = entry.date ? byDate.get(entry.date) : undefined
    if (bucket) bucket.push(entry)
    else anytime.push(entry)
  }

  const byCreated = (a: PlanEntry, b: PlanEntry) => (a.createdAt ?? 0) - (b.createdAt ?? 0)
  return {
    days: window.map((day) => ({ day, entries: (byDate.get(day.date) ?? []).sort(byCreated) })),
    anytime: anytime.sort(byCreated),
  }
}

/**
 * Flatten a plan into grocery additions: every planned recipe's ingredients,
 * each scaled to that entry's serving multiplier. Entries whose recipe can't be
 * found (deleted, or not loaded) are skipped. The caller hands the result to
 * addToList, which merges by canonical + unit — so two chicken dinners this week
 * combine into one "2 chickens" line rather than two.
 */
export function planToAdditions(
  entries: PlanEntry[],
  recipeBySlug: Map<string, Recipe>,
): Addition[] {
  const additions: Addition[] = []
  for (const entry of entries) {
    const recipe = recipeBySlug.get(entry.recipeSlug)
    if (!recipe) continue
    for (const ingredient of recipe.ingredients) {
      additions.push(additionFromIngredient(ingredient, entry.scale))
    }
  }
  return additions
}

/** How many of a plan's entries can actually be turned into groceries. */
export function plannedWithRecipes(
  entries: PlanEntry[],
  recipeBySlug: Map<string, Recipe>,
): number {
  return entries.filter((e) => recipeBySlug.has(e.recipeSlug)).length
}
