import { parseRecipe } from '../../src/lib/recipeSchema'
import type { Recipe } from '../../src/lib/types'
import cacio from '../../recipes/cacio-e-pepe.json'

const seed = parseRecipe(cacio).recipe
const base: Recipe = {
  ...seed,
  id: seed.slug,
  householdId: 'hh_preview',
  createdBy: 'u',
  createdAt: Date.now(),
  updatedAt: Date.now(),
}

// A couple of stand-ins so the list view has something to lay out.
const extras: Recipe[] = [
  { ...base, id: 'roast-chicken', slug: 'roast-chicken', title: 'Weeknight Roast Chicken',
    subtitle: 'Spatchcocked, high heat, forty minutes',
    tags: ['chicken', 'weeknight', 'roasting'],
    source: { ...base.source, name: "Cook's Illustrated", author: null },
    times: { prepMin: 10, cookMin: 40, totalMin: 50, activeMin: 15 },
    yield: { amount: 4, amountMax: null, unit: 'servings' } },
  { ...base, id: 'braised-short-ribs', slug: 'braised-short-ribs', title: 'Red Wine Braised Short Ribs',
    subtitle: 'A long Sunday afternoon, mostly unattended',
    tags: ['beef', 'braise', 'make-ahead', 'dinner-party'],
    source: { ...base.source, name: "America's Test Kitchen", author: null },
    times: { prepMin: 30, cookMin: 210, totalMin: 240, activeMin: 40 },
    yield: { amount: 6, amountMax: 8, unit: 'servings' } },
]

export { useRecipeSearch, collectTags } from '../../src/data/recipes.ts'

export function useRecipes() {
  return { recipes: [base, ...extras], loading: false, error: null }
}

export function useRecipe() {
  return { recipe: base, loading: false, error: null }
}
