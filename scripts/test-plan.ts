/**
 * Pure-logic tests for the meal plan: the day window, grouping, and the
 * plan→groceries aggregation. No Firebase, no DOM.
 *
 *   npm run test:plan
 */
import {
  addDays,
  groupPlan,
  isoDate,
  planToAdditions,
  plannedWithRecipes,
  planWindow,
} from '../src/lib/plan'
import type { Ingredient, PlanEntry, Recipe } from '../src/lib/types'

let passed = 0
let failed = 0
function check(label: string, cond: boolean): void {
  if (cond) {
    console.log(`  ✓ ${label}`)
    passed++
  } else {
    console.error(`  ✗ ${label}`)
    failed++
  }
}
function eq(label: string, actual: unknown, expected: unknown): void {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  check(`${label} (got ${a}, want ${e})`, a === e)
}

function ing(item: string, canonical: string, quantity: number | null, unit: string | null): Ingredient {
  return {
    id: canonical, quantity, quantityMax: null, unit, item, itemPlural: null,
    canonical, prep: null, alt: null, note: null, optional: false, scalable: true,
    category: 'produce', group: null, raw: item,
  }
}

function recipe(slug: string, ingredients: Ingredient[]): Recipe {
  return {
    id: slug, schemaVersion: 1, slug, title: slug, subtitle: null, description: null,
    source: { name: null, author: null, url: null, book: null, note: null },
    yield: { amount: 4, amountMax: null, unit: 'servings' },
    times: { prepMin: null, cookMin: null, totalMin: null, activeMin: null },
    ingredients, steps: [], groups: [], tags: [], equipment: [], notes: [], images: [],
    householdId: 'hh', visibility: 'household', createdBy: null, createdAt: null, updatedAt: null,
  }
}

function entry(id: string, slug: string, date: string | null, scale = 1, createdAt = 0): PlanEntry {
  return { id, recipeSlug: slug, recipeTitle: slug, date, scale, addedBy: null, createdAt }
}

console.log('Date helpers')
eq('isoDate is local yyyy-mm-dd', isoDate(new Date(2026, 8, 20)), '2026-09-20') // month 8 = Sep
eq('addDays crosses a month boundary', addDays('2026-09-30', 2), '2026-10-02')
eq('addDays goes backward', addDays('2026-01-01', -1), '2025-12-31')

console.log('Plan window')
const today = new Date(2026, 8, 20) // Sun Sep 20, 2026
const win = planWindow(today)
eq('window is 7 days', win.length, 7)
eq('first day is today', win[0].date, '2026-09-20')
eq('first label is Today', win[0].label, 'Today')
eq('second label is Tomorrow', win[1].label, 'Tomorrow')
eq('third label is a weekday', win[2].label, 'Tue')
eq('sub is a short date', win[0].sub, 'Sep 20')
eq('last day is today+6', win[6].date, '2026-09-26')

console.log('Grouping')
const entries: PlanEntry[] = [
  entry('a', 'soup', '2026-09-20', 1, 1),
  entry('b', 'tacos', '2026-09-22', 2, 2),
  entry('c', 'stew', null, 1, 3),            // no day → anytime
  entry('d', 'old', '2020-01-01', 1, 4),     // past date, off-window → anytime
  entry('e', 'chili', '2026-09-20', 1, 5),   // same day as a
]
const grouped = groupPlan(entries, win)
eq('today has two entries', grouped.days[0].entries.map((x) => x.id), ['a', 'e'])
eq('tuesday has the taco entry', grouped.days[2].entries.map((x) => x.id), ['b'])
eq('a bare day is empty', grouped.days[1].entries.length, 0)
eq('anytime holds undated + off-window', grouped.anytime.map((x) => x.id), ['c', 'd'])
check('every window day is present', grouped.days.length === 7)

console.log('Plan → grocery additions')
const recipes = new Map<string, Recipe>([
  ['soup', recipe('soup', [ing('onion', 'onion', 2, null), ing('stock', 'stock', 1, 'l')])],
  ['tacos', recipe('tacos', [ing('onion', 'onion', 1, null)])],
])
const plan: PlanEntry[] = [
  entry('a', 'soup', '2026-09-20', 1),
  entry('b', 'tacos', '2026-09-22', 2),   // scale 2 → 2 onions
  entry('z', 'ghost', null, 1),           // recipe not loaded → skipped
]
const additions = planToAdditions(plan, recipes)
eq('additions count = only real recipes’ ingredients', additions.length, 3)
const onion = additions.filter((a) => a.canonical === 'onion')
eq('two onion additions (one per recipe)', onion.length, 2)
eq('scaled taco onions = 2', onion.find((a) => a.quantity === 2) !== undefined, true)
eq('plannedWithRecipes ignores the ghost', plannedWithRecipes(plan, recipes), 2)

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed > 0 ? 1 : 0)
