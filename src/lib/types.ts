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
  /**
   * An optional concise, one-action-per-line version of `text` for cook mode —
   * authored deliberately, never generated at runtime. `text` stays the full
   * original prose (shown in the recipe reader); when `brief` is empty, cook
   * mode auto-splits `text` into sentences instead. Lines may carry {{ }} tokens
   * so amounts still scale. Nothing meaningful should live only in `brief`.
   */
  brief: string[]
  /** Ingredients used here — drives the "what you need now" panel in cook mode. */
  ingredientIds: string[]
  timers: Timer[]
  temperature: Temperature | null
  /**
   * Whether this step is a mostly-unattended wait the cook can step away from
   * (simmer, bake, rest, marinate…) vs. one that needs active attention (stir
   * constantly, a quick action). Set by AI import; absent on older/hand-authored
   * recipes, where cook mode falls back to a keyword heuristic. Additive and
   * optional — no migration; only drives cook mode's "work ahead" nudge.
   */
  handsOff?: boolean
  /**
   * Up to 3 step photos, shown in the reader and cook mode. Each entry is a
   * `photos` document id — the image itself is a compressed data URL stored on
   * that doc (see src/data/photos.ts), resolved for display with usePhotoUrls.
   * A visual aid, never where an instruction lives.
   */
  images: string[]
}

/**
 * A recipe's representative photo, shown atop the recipe page and on its card in
 * the kitchen list. `photo` is a `photos` doc id (the full image, like a step
 * photo — a `data:` URL only mid-edit, before save). `thumb` is the card image:
 * a 720×480 (3:2) JPEG data URL stored inline on the recipe, so the list can
 * show every card's photo large without fetching a photo doc per recipe. (Before
 * v0.41 it was a 240px square; `useCoverUpgrade` regenerates those.)
 */
export interface RecipeCover {
  photo: string
  thumb: string
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

/**
 * Who can see a recipe. Members always read every recipe in their household;
 * this only gates guests (friends):
 *  - 'friends'   — shared with everyone in the kitchen, members + guests. The
 *                  default: recipes are visible to guests unless hidden.
 *  - 'household' — members only; hidden from guests (the editor's "hide" option).
 *  - 'private'   — legacy; treated as members-only (guests can't see it).
 * The guest recipe listing filters on `visibility == 'friends'`.
 */
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
  /** Optional cover photo; null when there isn't one. Additive — no migration. */
  cover: RecipeCover | null

  householdId: string | null
  visibility: Visibility
  /**
   * A kitchen-wide favorite ("pin"). Shared: any member toggles it, guests see
   * it but can't change it (same as editing). Favorites sort to the top of the
   * recipe list and can be filtered to on their own. Absent on legacy docs =
   * not a favorite. Toggled on its own (never through the editor), so it's
   * excluded from RecipeSeed and a recipe edit leaves it untouched.
   */
  favorite: boolean
  createdBy: string | null
  createdAt: number | null
  updatedAt: number | null
  /**
   * Where this recipe came from: 'repo' = seeded from recipes/*.json (the old
   * repo sync, now retired), 'app' = created, copied, or edited inside the app.
   * Absent on legacy docs; treat as repo. Editing any recipe in the app flips it
   * to 'app'.
   */
  origin?: 'repo' | 'app'
  /**
   * For a recipe made by "copy to another kitchen": the slug of the lineage it
   * was copied from (the root original, propagated through chains of copies).
   * Lets the copy sheet warn "you already copied this here" instead of silently
   * making duplicates. Null for originals and recipes authored from scratch.
   */
  copiedFrom?: string | null
  /**
   * An import waiting for someone to look it over (0.50): every import lands
   * here first, listed under Add a recipe › "Recipes awaiting review", and
   * joins the kitchen when a member approves it. Until then it's saved
   * members-only (`visibility: 'household'`), so guests never see it, and it's
   * left out of the kitchen list. Stored as `inReview: true` + `review`, both
   * deleted on approval. Null for everything else.
   */
  review?: RecipeReview | null
}

export interface RecipeReview {
  /** Who imported it (uid), and their name as it was then. */
  by: string | null
  byName: string | null
  /** When it arrived (ms). */
  at: number | null
  /** Who'll see it once approved — what the import chose (usually 'friends'). */
  visibility: Visibility
  /** What the import couldn't bring, in words ("3 of 5 photos came through"). */
  note: string | null
}

/** What lives in recipes/*.json — the server fills in the rest. `favorite` is
 * toggled on its own, not authored/edited, so it's not part of a seed either;
 * nor is `review` (approving is its own step). */
export type RecipeSeed = Omit<
  Recipe,
  'id' | 'householdId' | 'createdBy' | 'createdAt' | 'updatedAt' | 'favorite' | 'review'
>

/**
 * One line on the shared grocery list. Lives in a subcollection so two people
 * checking things off at once never clobber each other's writes. `canonical`
 * is the merge key (2 onions + 1 onion → 3), `category` sets the aisle.
 */
export interface GroceryItem {
  id: string
  /** Display name, e.g. "yellow onion". */
  name: string
  /** Merge key shared with Ingredient.canonical. */
  canonical: string
  quantity: number | null
  quantityMax: number | null
  unit: string | null
  category: GroceryCategory
  checked: boolean
  /** Free note, or which recipe(s) it came from. */
  note: string | null
  addedBy: string | null
  createdAt: number | null
  updatedAt: number | null
}

/**
 * A live, shared cook session — the two-phone "cook together" mode. One doc per
 * household (id = householdId), so both phones follow the same current step and
 * the same timers. Timers are stored endsAt-first (a wall-clock epoch) so each
 * phone derives the countdown itself without the two writing every tick.
 */
export interface SyncTimer {
  id: string
  label: string
  /** Original duration in seconds, for reset. */
  total: number
  /** Epoch ms it will hit zero, or null while paused. */
  endsAt: number | null
  /** Seconds left, meaningful while paused; derived from endsAt while running. */
  remaining: number
  /** stepId:label — lets a step show "running" instead of a second Start. */
  source: string
  /** The step's number (1-based), for the notification ("step 3"). Absent on
   * timers started before 0.50. */
  step?: number
}

export interface CookSession {
  householdId: string
  recipeSlug: string
  recipeTitle: string
  /** Serving multiplier the session is cooking at. */
  scale: number
  /** The step both phones are on. */
  stepIndex: number
  timers: SyncTimer[]
  startedBy: string | null
  startedByName: string | null
  updatedAt: number | null
  /** False once someone stops the session; the doc lingers but is ignored. */
  active: boolean
}

/**
 * One dish on this device's cook board — a solo (unsynced) cook in progress,
 * kept in localStorage so it survives leaving the app and, crucially, so several
 * can run at once. Cooking a real meal means juggling dishes: the ribs braise
 * while you start the rice while you prep the beans. Each dish tracks where you
 * are and its own timers (stored endsAt-first, so they keep counting down even
 * when its cook page isn't open), and the "cooking now" timeline reads the whole
 * board to show every dish side by side. `title` is denormalized so a banner can
 * name it without loading the recipe. The two-phone `CookSession` is separate:
 * that syncs one shared recipe across phones; this board is personal to a device.
 */
export interface CookDish {
  slug: string
  title: string
  /** Serving multiplier (mirrors the reader's scale; 1 = as written). */
  scale: number
  /** The step you're on in this dish. */
  stepIndex: number
  timers: SyncTimer[]
  /** When this dish was first added to the board. */
  startedAt: number
  updatedAt: number
}

export interface Household {
  id: string
  name: string
  ownerUid: string
  /** Full read/write on recipes, lists, and the cook log. */
  memberUids: string[]
  /** Read-only on recipes shared with visibility 'friends'. */
  friendUids: string[]
  /** The most recently minted invite code, shown so members can share it. */
  inviteCode: string | null
  createdAt: number | null
}

export type HouseholdRole = 'member' | 'friend'

/** An invite document, keyed by its own (secret, unguessable) code. */
export interface Invite {
  code: string
  householdId: string
  /** Denormalized so the join prompt can name the kitchen before joining. */
  householdName: string | null
  role: HouseholdRole
  createdBy: string
}

export interface UserProfile {
  uid: string
  displayName: string | null
  email: string | null
  photoURL: string | null
  /** Households this user belongs to, mirrored for cheap lookup. */
  householdIds: string[]
  defaultHouseholdId: string | null
  /**
   * The invite code the user is mid-redeeming. Staged here so the security
   * rules can verify which invite authorizes a self-add to a household —
   * rules can read documents but not client variables or query filters.
   */
  pendingInvite: string | null
}
