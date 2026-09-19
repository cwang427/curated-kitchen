import { addDays, isoDate } from '../../src/lib/plan'
import type { PlanEntry } from '../../src/lib/types'

const today = isoDate(new Date())

const FIXTURE: PlanEntry[] = [
  { id: '1', recipeSlug: 'cacio-e-pepe', recipeTitle: 'Cacio e Pepe', date: today, scale: 1, addedBy: null, createdAt: 1 },
  { id: '2', recipeSlug: 'roast-chicken', recipeTitle: 'Weeknight Roast Chicken', date: addDays(today, 1), scale: 2, addedBy: null, createdAt: 2 },
  { id: '3', recipeSlug: 'braised-short-ribs', recipeTitle: 'Red Wine Braised Short Ribs', date: addDays(today, 3), scale: 1, addedBy: null, createdAt: 3 },
  { id: '4', recipeSlug: 'cacio-e-pepe', recipeTitle: 'Cacio e Pepe', date: null, scale: 1, addedBy: null, createdAt: 4 },
]

export function usePlan() {
  return { entries: FIXTURE, loading: false, error: null }
}
export async function addPlanEntry() {}
export async function setPlanEntryDate() {}
export async function removePlanEntry() {}
export async function clearPlan() {
  return 0
}
