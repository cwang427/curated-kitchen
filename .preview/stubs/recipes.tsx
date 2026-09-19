import { parseRecipe } from '../../src/lib/recipeSchema'
import type { Recipe } from '../../src/lib/types'
import cacio from '../../recipes/cacio-e-pepe.json'
import shortRibs from '../../recipes/braised-chinese-short-ribs.json'

function hydrate(seedInput: unknown): Recipe {
  const seed = parseRecipe(seedInput).recipe
  return {
    ...seed,
    id: seed.slug,
    householdId: 'hh_preview',
    createdBy: 'u',
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }
}

const cacioRecipe = hydrate(cacio)
const shortRibsRecipe = hydrate(shortRibs)

// A light stand-in so the list view has a third card to lay out.
const roast: Recipe = {
  ...cacioRecipe,
  id: 'roast-chicken',
  slug: 'roast-chicken',
  title: 'Weeknight Roast Chicken',
  subtitle: 'Spatchcocked, high heat, forty minutes',
  tags: ['chicken', 'weeknight', 'roasting'],
  source: { ...cacioRecipe.source, name: "Cook's Illustrated", author: null },
  times: { prepMin: 10, cookMin: 40, totalMin: 50, activeMin: 15 },
  yield: { amount: 4, amountMax: null, unit: 'servings' },
}

const ALL = [cacioRecipe, shortRibsRecipe, roast]

export { useRecipeSearch, collectTags } from '../../src/data/recipes.ts'

export function useRecipes() {
  return { recipes: ALL, loading: false, error: null }
}

// Pick the recipe from the URL (/r/:slug/…), so cook mode shows the right one.
export function useRecipe() {
  const slug = window.location.pathname.split('/r/')[1]?.split('/')[0]
  const recipe = ALL.find((r) => r.slug === slug) ?? cacioRecipe
  return { recipe, loading: false, error: null }
}
