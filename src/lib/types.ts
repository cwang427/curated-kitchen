/**
 * Curated Kitchen data model.
 *
 * The central bet of this app: ingredients are structured data, never prose.
 * Scaling, grocery aggregation, and step/ingredient linking all fall out of
 * the `Ingredient` shape below. `raw` always preserves the original line so
 * nothing written by hand is ever lost to a parsing decision.
 */

export const SCHEMA_VERSION = 1 as const

/** Supermarket sections, used to sort the shopping list into walking order. */
export const GROCERY_CATEGORIES = [
  'produce',
  'meat',
  'seafood',
  'dairy',
  'bakery',
  'deli',
  'frozen',
  'pantry',
  'spices',
  'condiments',
  'baking',
  'beverages',
  'alcohol',
  'household',
  'other',
] as const
export type GroceryCategory = (typeof GROCERY_CATEGORIES)[number]

/**
 * What kind of thing a unit measures. Scaling and grocery aggregation may
 * combine quantities within one dimension but never across two: converting
 * volume to mass needs a per-ingredient density and silently produces wrong
 * numbers, so we refuse to do it.
 */
export type Dimension = 'mass' | 'volume' | 'count' | 'length' | 'unitless'

export interface Ingredient {
  /** Stable within the recipe; referenced by Step.ingredientIds. */
  id: string
  /** null for "salt to taste" or "a handful of parsley". */
  quantity: number | null
  /** Upper bound of a range: "2–3 cloves" is quantity 2, quantityMax 3. */
  quantityMax: number | null
  /** Canonical unit key (see units.ts), or null for countable items. */
  unit: string | null
  /** Display name, singular: "yellow onion". */
  item: string
  /** Explicit plural when the auto-pluralizer would get it wrong. */
  itemPlural: string | null
  /** Merge key for grocery aggregation: "onion_yellow". */
  canonical: string
  /** "finely diced", "at room temperature". */
  prep: string | null
  /**
   * A parallel measurement shown in parentheses — the "12 oz" in
   * "340 g bucatini (12 oz)". Structured rather than free text so it scales
   * with everything else instead of going stale.
   */
  alt: { quantity: number; unit: string | null } | null
  /** Non-numeric aside: "plus more for serving". */
  note: string | null
  optional: boolean
  /**
   * False for anything that must not multiply with servings — "salt to
   * taste", "oil for frying", "water for boiling the pasta".
   */
  scalable: boolean
  category: GroceryCategory
  /** Component this belongs to, matching an entry in Recipe.groups. */
  group: string | null
  /** The line exactly as originally written. Never edited by the app. */
  raw: string
}

export interface Timer {
  label: string
  seconds: number
}

export interface Temperature {
  value: number
  unit: 'F' | 'C'
  mode: 'oven' | 'internal' | 'oil' | 'surface' | 'water' | 'other'
}

export interface Step {
  id: string
  text: string
  group: string | null
  /** Ingredients used here — drives the "what you need now" panel in cook mode. */
  ingredientIds: string[]
  timers: Timer[]
  temperature: Temperature | null
}

export interface RecipeSource {
  /** "Serious Eats", "Cook's Illustrated", "Apple Notes". */
  name: string | null
  author: string | null
  url: string | null
  book: string | null
  /** How this diverges from the original: "halved the garlic, no anchovy". */
  note: string | null
}

export interface RecipeYield {
  amount: number
  amountMax: number | null
  /** "servings", "cookies", "loaf". */
  unit: string
}

export interface Times {
  prepMin: number | null
  cookMin: number | null
  totalMin: number | null
  /** Hands-on time, which is what actually decides a weeknight. */
  activeMin: number | null
}

export type Visibility = 'private' | 'household' | 'friends'

export interface Recipe {
  id: string
  schemaVersion: typeof SCHEMA_VERSION
  slug: string
  title: string
  subtitle: string | null
  description: string | null
  source: RecipeSource
  yield: RecipeYield
  times: Times
  ingredients: Ingredient[]
  steps: Step[]
  /** Ordered component names: ["For the sauce", "For the pasta"]. */
  groups: string[]
  tags: string[]
  equipment: string[]
  /** Headnotes and tips, kept separate from steps. */
  notes: string[]
  images: string[]

  householdId: string | null
  visibility: Visibility
  createdBy: string | null
  createdAt: number | null
  updatedAt: number | null
}

/** What lives in recipes/*.json — the server fills in the rest. */
export type RecipeSeed = Omit<
  Recipe,
  'id' | 'householdId' | 'createdBy' | 'createdAt' | 'updatedAt'
>

export interface Household {
  id: string
  name: string
  ownerUid: string
  /** Full read/write on recipes, lists, and the cook log. */
  memberUids: string[]
  /** Read-only on recipes shared with visibility 'friends'. */
  friendUids: string[]
  createdAt: number | null
}

export interface UserProfile {
  uid: string
  displayName: string | null
  email: string | null
  photoURL: string | null
  /** Households this user belongs to, mirrored for cheap lookup. */
  householdIds: string[]
  defaultHouseholdId: string | null
}
