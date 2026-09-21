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
    favorite: false,
    createdBy: 'u',
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }
}

const cacioRecipe = hydrate(cacio)
// Preview step photos, so the reader / cook mode / editor render with images.
const STEP_PHOTO =
  'data:image/svg+xml,' +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="480" height="360"><rect width="100%" height="100%" fill="#e9c9a8"/><text x="50%" y="50%" font-family="sans-serif" font-size="30" fill="#8a5a2b" text-anchor="middle" dominant-baseline="middle">step photo</text></svg>',
  )
cacioRecipe.steps[0].images = [STEP_PHOTO, STEP_PHOTO]
cacioRecipe.steps[1].images = [STEP_PHOTO]
// Members-only, so the guest view hides it and Settings › Guests has something
// to offer sharing.
const shortRibsRecipe: Recipe = { ...hydrate(shortRibs), visibility: 'household' }

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
  // Shared with guests, so the ?asfriend preview has something to show.
  visibility: 'friends',
  // A favorite, so the list pins it to the top and the heart shows filled.
  favorite: true,
}

const ALL = [cacioRecipe, shortRibsRecipe, roast]

export { useRecipeSearch, collectTags } from '../../src/data/recipes.ts'
export async function setRecipeFavorite(): Promise<void> {}

export function useRecipes(_householdId?: string | null, _nonce?: number, friendsOnly = false) {
  const recipes = (friendsOnly ? ALL.filter((r) => r.visibility === 'friends') : ALL)
    // Mirror the real listener: favorites pinned to the top, then by title.
    .slice()
    .sort((a, b) => Number(b.favorite) - Number(a.favorite) || a.title.localeCompare(b.title))
  return { recipes, loading: false, error: null }
}

// Pick the recipe from the URL (/r/:slug/…), so cook mode shows the right one.
export function useRecipe() {
  const slug = window.location.pathname.split('/r/')[1]?.split('/')[0]
  const recipe = ALL.find((r) => r.slug === slug) ?? cacioRecipe
  return { recipe, loading: false, error: null }
}

export async function copyRecipeToHousehold(): Promise<string> {
  return 'copied-recipe'
}
export function recipeLineage(recipe: Recipe): string {
  return recipe.copiedFrom ?? recipe.slug
}
export async function fetchHouseholdRecipes(householdId: string): Promise<Recipe[]> {
  // Add ?dupe to the URL to simulate a kitchen already holding a copy of the
  // open recipe (shows the "Already copied" flag on the copy sheet).
  const params = new URLSearchParams(window.location.search)
  if (!params.has('dupe')) return []
  const slug = window.location.pathname.split('/r/')[1]?.split('/')[0] ?? 'cacio-e-pepe'
  return [{ ...cacioRecipe, id: `${householdId}-copy`, slug: `${slug}-copy`, title: 'Cacio e Pepe', copiedFrom: slug }]
}
export async function deleteRecipe(): Promise<void> {}
export async function shareRecipesWithGuests(slugs: string[]): Promise<number> {
  return slugs.length
}
export async function createRecipeInHousehold(): Promise<string> {
  return 'new-recipe'
}
export async function updateRecipe(): Promise<string> {
  return 'edited-recipe'
}
