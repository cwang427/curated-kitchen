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
// A stand-in cover photo (golden roast on a board) for the list thumbnail and hero.
const COVER_PHOTO =
  'data:image/svg+xml,' +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="600" height="400"><defs><radialGradient id="g" cx="50%" cy="45%" r="60%"><stop offset="0" stop-color="#e8a54b"/><stop offset="1" stop-color="#8a4b1c"/></radialGradient></defs><rect width="100%" height="100%" fill="#5b3a26"/><ellipse cx="300" cy="215" rx="230" ry="150" fill="#d9c3a3"/><ellipse cx="300" cy="200" rx="160" ry="105" fill="url(#g)"/><circle cx="170" cy="310" r="22" fill="#6b8e23"/><circle cx="430" cy="300" r="18" fill="#6b8e23"/></svg>',
  )
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
  // A cover photo, so the recipe page hero and the list thumbnail render.
  cover: { photo: COVER_PHOTO, thumb: COVER_PHOTO },
}

// ?many: a bigger kitchen, to judge how the grid reads as it grows.
const EXTRA: Array<[string, string[], boolean, boolean, number]> = [
  ['Weeknight Chicken Tikka Masala', ['mains', 'indian', 'curry'], true, false, 45],
  ['Crispy Smashed Potatoes', ['sides'], true, false, 50],
  ['Miso Salmon', ['mains', 'japanese'], false, true, 25],
  ['The Best Corn Chowder', ['soup'], false, false, 60],
  ['Brown Butter Chocolate Chip Cookies', ['desserts', 'cookies'], true, false, 40],
  ['Shakshuka', ['breakfast', 'middle-eastern'], false, false, 30],
  ['Sichuan Dry-Fried Green Beans', ['sides', 'chinese'], true, false, 20],
  ['Lemony White Bean and Kale Soup with Parmesan Rind', ['soup', 'vegetarian'], false, false, 55],
  ['Classic Margarita', ['drinks'], false, false, 5],
  ['Pork and Chive Dumplings', ['dumplings', 'chinese'], true, true, 90],
  ['Caesar Salad', ['salad'], false, false, 20],
  ['Focaccia', ['bread', 'italian'], true, false, 240],
]
const MANY: Recipe[] = typeof location !== 'undefined' && location.search.includes('many')
  ? EXTRA.map(([title, tags, cover, favorite, totalMin], i) => ({
      ...cacioRecipe,
      id: `extra-${i}`,
      slug: `extra-${i}`,
      title,
      tags,
      favorite,
      visibility: 'friends' as const,
      times: { prepMin: null, cookMin: null, activeMin: null, totalMin },
      cover: cover ? { photo: COVER_PHOTO, thumb: COVER_PHOTO } : null,
    }))
  : []

const ALL = [cacioRecipe, shortRibsRecipe, roast, ...MANY]

// Imports awaiting review (Add a recipe's list, and /review/:slug).
const chowder: Recipe = {
  ...hydrate(shortRibs),
  id: 'corn-chowder',
  slug: 'corn-chowder',
  title: 'The Best Corn Chowder',
  visibility: 'household',
  cover: { photo: COVER_PHOTO, thumb: COVER_PHOTO },
  review: { by: 'u', byName: 'Cassidy', at: Date.now() - 12 * 60_000, visibility: 'friends', note: '5 of 6 photos came through — the rest took too long.' },
}
const brisket: Recipe = {
  ...cacioRecipe,
  id: 'grandmas-brisket',
  slug: 'grandmas-brisket',
  title: 'Grandma’s Brisket',
  visibility: 'household',
  cover: null,
  review: { by: 'someone-else', byName: 'Sam', at: Date.now() - 3 * 3600_000, visibility: 'friends', note: null },
}
const REVIEW = [chowder, brisket]

export { useRecipeSearch, collectTags } from '../../src/data/recipes.ts'
export async function setRecipeFavorite(): Promise<void> {}
export function useCoverUpgrade(): void {}

export function useRecipes(_householdId?: string | null, _nonce?: number, friendsOnly = false) {
  const recipes = (friendsOnly ? ALL.filter((r) => r.visibility === 'friends') : ALL)
    // Mirror the real listener: favorites pinned to the top, then by title.
    .slice()
    .sort((a, b) => Number(b.favorite) - Number(a.favorite) || a.title.localeCompare(b.title))
  return { recipes, loading: false, error: null }
}

// Pick the recipe from the URL (/r/:slug/…), so cook mode shows the right one.
export function useRecipe() {
  const slug = window.location.pathname.split(/\/(?:r|review)\//)[1]?.split('/')[0]
  const recipe = [...ALL, ...REVIEW].find((r) => r.slug === slug) ?? cacioRecipe
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
export async function saveForReview(): Promise<string> {
  return 'new-recipe'
}
export async function approveRecipe(): Promise<void> {}
export function watchReviews() {
  return () => {}
}
export function useReviewRecipes() {
  const on = window.location.search.includes('queuedemo') || window.location.pathname.includes('/review/')
  return { householdId: 'hh_preview', recipes: on ? REVIEW : [], loading: false }
}
