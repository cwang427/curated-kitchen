import { useEffect, useMemo, useState } from 'react'
import {
  collection,
  deleteDoc,
  deleteField,
  doc,
  getDocs,
  onSnapshot,
  query,
  serverTimestamp,
  setDoc,
  where,
  writeBatch,
  type DocumentData,
} from 'firebase/firestore'
import { db } from '../lib/firebase'
import { copyPhotoToHousehold, coverThumbFromDataUrl, fetchPhoto, isLegacyCoverThumb } from './photos'
import { SCHEMA_VERSION, type Recipe, type RecipeCover, type RecipeReview, type RecipeSeed } from '../lib/types'
import { normalizeTags } from '../lib/tags'

function toMillis(value: unknown): number | null {
  if (value && typeof value === 'object' && 'toMillis' in value) {
    return (value as { toMillis: () => number }).toMillis()
  }
  return typeof value === 'number' ? value : null
}

function toRecipe(id: string, data: DocumentData): Recipe {
  return {
    id,
    schemaVersion: SCHEMA_VERSION,
    slug: data.slug ?? id,
    title: data.title ?? 'Untitled',
    subtitle: data.subtitle ?? null,
    description: data.description ?? null,
    source: data.source ?? { name: null, author: null, url: null, book: null, note: null },
    yield: data.yield ?? { amount: 1, amountMax: null, unit: 'servings' },
    times: data.times ?? { prepMin: null, cookMin: null, totalMin: null, activeMin: null },
    ingredients: data.ingredients ?? [],
    // Recipes saved before per-step photos have steps with no `images` field;
    // the reader and cook mode iterate it, so coerce it to [] here — this is the
    // one boundary where raw Firestore data becomes a typed Recipe.
    steps: (data.steps ?? []).map((step: DocumentData) => ({
      ...step,
      images: Array.isArray(step?.images) ? step.images : [],
    })),
    groups: data.groups ?? [],
    tags: data.tags ?? [],
    equipment: data.equipment ?? [],
    notes: data.notes ?? [],
    images: data.images ?? [],
    cover:
      typeof data.cover?.photo === 'string' && typeof data.cover?.thumb === 'string'
        ? { photo: data.cover.photo, thumb: data.cover.thumb }
        : null,
    householdId: data.householdId ?? null,
    visibility: data.visibility ?? 'friends',
    favorite: data.favorite === true,
    createdBy: data.createdBy ?? null,
    createdAt: toMillis(data.createdAt),
    updatedAt: toMillis(data.updatedAt),
    origin: data.origin === 'app' ? 'app' : data.origin === 'repo' ? 'repo' : undefined,
    copiedFrom: typeof data.copiedFrom === 'string' ? data.copiedFrom : null,
    review: data.inReview === true ? toReview(data.review) : null,
  }
}

function toReview(raw: DocumentData | undefined): RecipeReview {
  return {
    by: typeof raw?.by === 'string' ? raw.by : null,
    byName: typeof raw?.byName === 'string' ? raw.byName : null,
    at: toMillis(raw?.at),
    visibility: raw?.visibility === 'household' || raw?.visibility === 'private' ? 'household' : 'friends',
    note: typeof raw?.note === 'string' ? raw.note : null,
  }
}

export interface RecipesState {
  recipes: Recipe[]
  loading: boolean
  error: string | null
}

export function useRecipes(householdId: string | null, nonce = 0, friendsOnly = false): RecipesState {
  const [recipes, setRecipes] = useState<Recipe[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!householdId) {
      setRecipes([])
      setLoading(false)
      return
    }
    // `nonce` is a manual refresh signal: bumping it re-runs this effect,
    // tearing down and re-creating the listener. That forces a fresh server
    // round-trip, which is how pull-to-refresh recovers a listener that went
    // stale after the PWA was backgrounded on iOS.
    void nonce

    setLoading(true)
    // Filtering by householdId is what makes this pass the security rules:
    // every document returned belongs to a household the user belongs to.
    //
    // A guest (friend, not member) can only read recipes marked
    // visibility 'friends', so their query MUST add that filter — otherwise
    // Firestore refuses the whole listing (it can't prove every recipe is
    // guest-readable). Two equality filters need no composite index.
    //
    // Sorting happens below rather than via orderBy() on purpose: a filter
    // plus an orderBy needs a composite index, which is one more thing to
    // create before the app works. Everything is already in memory for search.
    const q = friendsOnly
      ? query(
          collection(db, 'recipes'),
          where('householdId', '==', householdId),
          where('visibility', '==', 'friends'),
        )
      : query(collection(db, 'recipes'), where('householdId', '==', householdId))

    return onSnapshot(
      q,
      (snapshot) => {
        setRecipes(
          snapshot.docs
            .map((d) => toRecipe(d.id, d.data()))
            // Imports awaiting review aren't in the kitchen yet (a member's
            // query returns them; a guest's never does — they're members-only).
            .filter((r) => !r.review)
            // Favorites pin to the top; ties (and everything else) by title.
            .sort(
              (a, b) => Number(b.favorite) - Number(a.favorite) || a.title.localeCompare(b.title),
            ),
        )
        setError(null)
        setLoading(false)
      },
      (cause) => {
        setError(cause.message)
        setLoading(false)
      },
    )
  }, [householdId, nonce, friendsOnly])

  return { recipes, loading, error }
}

export interface RecipeState {
  recipe: Recipe | null
  loading: boolean
  error: string | null
}

/** Recipe documents are keyed by slug, so the URL is the document id. */
export function useRecipe(slug: string | undefined): RecipeState {
  const [recipe, setRecipe] = useState<Recipe | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!slug) {
      setRecipe(null)
      setLoading(false)
      return
    }

    setLoading(true)
    return onSnapshot(
      doc(db, 'recipes', slug),
      (snapshot) => {
        setRecipe(snapshot.exists() ? toRecipe(snapshot.id, snapshot.data()) : null)
        setError(null)
        setLoading(false)
      },
      (cause) => {
        setError(cause.message)
        setLoading(false)
      },
    )
  }, [slug])

  return { recipe, loading, error }
}

/**
 * Client-side search. With a few hundred recipes this beats a Firestore
 * index or a search service: everything is already cached locally, so it
 * works offline and updates as you type.
 */
export function useRecipeSearch(recipes: Recipe[], term: string, tags: string[]): Recipe[] {
  return useMemo(() => {
    const needle = term.trim().toLowerCase()

    return recipes.filter((recipe) => {
      // Filter on the fixed-list form, so an older recipe tagged "Main Course"
      // still matches the "mains" chip.
      if (tags.length > 0) {
        const own = normalizeTags(recipe.tags)
        if (!tags.every((tag) => own.includes(tag))) return false
      }
      if (!needle) return true

      const haystack = [
        recipe.title,
        recipe.subtitle ?? '',
        recipe.source.name ?? '',
        recipe.source.author ?? '',
        ...recipe.tags,
        ...recipe.ingredients.map((i) => i.item),
      ]
        .join(' ')
        .toLowerCase()

      return haystack.includes(needle)
    })
  }, [recipes, term, tags])
}

/** The kitchen's filter chips: the fixed-list tags its recipes actually use,
 * in browse order (course → cuisine → dish → diet → occasion). Tags off the
 * list — an older import's "beef" or "pressure cooker" — never show. */
export function collectTags(recipes: Recipe[]): string[] {
  const used = new Set(recipes.flatMap((recipe) => normalizeTags(recipe.tags)))
  return normalizeTags([...used])
}

/** A short, URL-safe suffix so a copied recipe gets a globally unique slug. */
function randomSuffix(): string {
  return Math.random().toString(36).slice(2, 7)
}

/**
 * Copy a recipe into another kitchen the caller belongs to. Recipes are keyed by
 * slug (the doc id and the URL), which is global, so the copy gets a fresh
 * unique slug. It's marked origin 'app' so the recipe-sync prune leaves it be.
 * Returns the new slug. The rules allow this only if you're a member of the
 * target household.
 */
export async function copyRecipeToHousehold(
  recipe: Recipe,
  targetHouseholdId: string,
  uid: string,
): Promise<string> {
  const slug = `${recipe.slug}-${randomSuffix()}`
  // Duplicate each step's photos into the target household so the copy fully
  // owns its images. Photos are Firestore docs now (not Storage objects), and
  // Firestore reads/writes aren't CORS-restricted, so we can read the source
  // doc and re-store its bytes under the new household — a true independent
  // copy. Removing a photo from one recipe can therefore never blank another.
  // A photo that can't be read is dropped from that step (best-effort), never
  // blocking the copy.
  const steps = await Promise.all(
    recipe.steps.map(async (step) => {
      if (step.images.length === 0) return step
      const copied = await Promise.all(
        step.images.map((id) => copyPhotoToHousehold(id, targetHouseholdId, uid)),
      )
      return { ...step, images: copied.filter((x): x is string => !!x) }
    }),
  )
  // The cover photo too (its card image is inline, so it copies as-is).
  const coverPhoto = recipe.cover
    ? await copyPhotoToHousehold(recipe.cover.photo, targetHouseholdId, uid)
    : null
  const cover = recipe.cover && coverPhoto ? { photo: coverPhoto, thumb: recipe.cover.thumb } : null
  await setDoc(doc(db, 'recipes', slug), {
    schemaVersion: recipe.schemaVersion,
    slug,
    title: recipe.title,
    subtitle: recipe.subtitle,
    description: recipe.description,
    source: recipe.source,
    yield: recipe.yield,
    times: recipe.times,
    ingredients: recipe.ingredients,
    steps,
    groups: recipe.groups,
    tags: recipe.tags,
    equipment: recipe.equipment,
    notes: recipe.notes,
    images: recipe.images,
    cover,
    visibility: recipe.visibility,
    householdId: targetHouseholdId,
    origin: 'app',
    // Remember the lineage so we can spot duplicate copies. Chains of copies all
    // point at the same root original.
    copiedFrom: recipe.copiedFrom ?? recipe.slug,
    createdBy: uid,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  })
  return slug
}

/**
 * The lineage id used to spot duplicate copies: a copy's root original, or the
 * recipe's own slug if it isn't itself a copy.
 */
export function recipeLineage(recipe: Recipe): string {
  return recipe.copiedFrom ?? recipe.slug
}

/**
 * One-shot read of a household's recipes (not a live subscription) — used by the
 * copy sheet to check whether a recipe's lineage is already there. Membership is
 * enforced by the rules, same as the live listener.
 */
export async function fetchHouseholdRecipes(householdId: string): Promise<Recipe[]> {
  const snap = await getDocs(
    query(collection(db, 'recipes'), where('householdId', '==', householdId)),
  )
  return snap.docs.map((d) => toRecipe(d.id, d.data())).filter((r) => !r.review)
}

/** Delete a recipe. The rules allow this only for members of its household. */
export async function deleteRecipe(slug: string): Promise<void> {
  await deleteDoc(doc(db, 'recipes', slug))
}

/**
 * Toggle a recipe's kitchen-wide favorite ("pin"). A member merge-update that
 * touches only `favorite` (and updatedAt), so the rules allow it and nothing
 * else on the doc changes. Guests can't call this (the rules deny their write);
 * the UI hides the button for them. Not marked origin 'app' — favoriting isn't
 * authoring.
 */
export async function setRecipeFavorite(slug: string, favorite: boolean): Promise<void> {
  await setDoc(
    doc(db, 'recipes', slug),
    { favorite, updatedAt: serverTimestamp() },
    { merge: true },
  )
}

/**
 * Mark several recipes visible to guests (visibility 'friends'). Used by the
 * one-tap "make all recipes visible to guests" action, and to bring pre-existing
 * recipes into the new share-by-default model. A member merge-update keeps
 * householdId, so the rules allow it. Batched (a kitchen is well under 500).
 */
export async function shareRecipesWithGuests(slugs: string[]): Promise<number> {
  if (slugs.length === 0) return 0
  const batch = writeBatch(db)
  for (const slug of slugs) {
    batch.set(
      doc(db, 'recipes', slug),
      { visibility: 'friends', updatedAt: serverTimestamp() },
      { merge: true },
    )
  }
  await batch.commit()
  return slugs.length
}

/**
 * Save a validated recipe seed (e.g. from AI import) into a household as an
 * app-created recipe. The seed already carries a fresh unique slug. Rules allow
 * this only for members of the target household.
 */
export async function createRecipeInHousehold(
  seed: RecipeSeed,
  householdId: string,
  uid: string,
): Promise<string> {
  await setDoc(doc(db, 'recipes', seed.slug), {
    ...seed,
    householdId,
    origin: 'app',
    createdBy: uid,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  })
  return seed.slug
}

/**
 * Save an import for review: in the kitchen's records, but members-only and
 * out of the kitchen list until someone approves it (approveRecipe). Every
 * member sees it under Add a recipe › "Recipes awaiting review".
 */
export async function saveForReview(
  seed: RecipeSeed,
  householdId: string,
  by: { uid: string; name: string | null },
  note: string | null,
): Promise<string> {
  const review: RecipeReview = { by: by.uid, byName: by.name, at: Date.now(), visibility: seed.visibility === 'friends' ? 'friends' : 'household', note }
  await setDoc(doc(db, 'recipes', seed.slug), {
    ...seed,
    visibility: 'household',
    inReview: true,
    review,
    householdId,
    origin: 'app',
    createdBy: by.uid,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  })
  return seed.slug
}

/** Approve an import: it joins the kitchen, seen by whoever the import chose. */
export async function approveRecipe(recipe: Recipe): Promise<void> {
  await setDoc(
    doc(db, 'recipes', recipe.slug),
    {
      visibility: recipe.review?.visibility ?? 'friends',
      inReview: deleteField(),
      review: deleteField(),
      updatedAt: serverTimestamp(),
    },
    { merge: true },
  )
}

// The kitchen's imports awaiting review — one live listener for the whole app
// (the header's badge and the Add a recipe list both read it), not one per
// screen.
type ReviewSnapshot = { householdId: string | null; recipes: Recipe[]; loading: boolean }
let reviewSnapshot: ReviewSnapshot = { householdId: null, recipes: [], loading: true }
const reviewListeners = new Set<() => void>()
function publishReviews(next: ReviewSnapshot): void {
  reviewSnapshot = next
  for (const listener of reviewListeners) listener()
}

/** Keep the review list for this kitchen live (members only — a guest's query
 * would be refused, and they never review). Returns the unsubscribe. */
export function watchReviews(householdId: string | null): () => void {
  if (!householdId) {
    publishReviews({ householdId: null, recipes: [], loading: false })
    return () => {}
  }
  publishReviews({ householdId, recipes: [], loading: true })
  // Two equality filters: no composite index needed.
  const q = query(collection(db, 'recipes'), where('householdId', '==', householdId), where('inReview', '==', true))
  return onSnapshot(
    q,
    (snapshot) =>
      publishReviews({
        householdId,
        loading: false,
        recipes: snapshot.docs.map((d) => toRecipe(d.id, d.data())).sort((a, b) => (b.review?.at ?? 0) - (a.review?.at ?? 0)),
      }),
    () => publishReviews({ householdId, recipes: [], loading: false }),
  )
}

/** The imports awaiting review in the active kitchen, newest first. */
export function useReviewRecipes(): ReviewSnapshot {
  const [state, setState] = useState(reviewSnapshot)
  useEffect(() => {
    const listener = () => setState(reviewSnapshot)
    reviewListeners.add(listener)
    setState(reviewSnapshot)
    return () => void reviewListeners.delete(listener)
  }, [])
  return state
}

/** Swap in a regenerated cover card image, leaving the rest of the recipe
 * (and its updatedAt) alone — a display upgrade, not an edit. */
export async function setRecipeCover(slug: string, cover: RecipeCover): Promise<void> {
  await setDoc(doc(db, 'recipes', slug), { cover }, { merge: true })
}

// Covers already checked this session, so the kitchen list's re-renders (and
// the snapshot our own upgrade write triggers) never re-check or re-write one.
const coversChecked = new Set<string>()

/**
 * Covers saved before v0.41 carry a 240px square card image — blurry on the big
 * kitchen cards. For members, regenerate each one once from its full photo; the
 * list's live subscription then swaps the sharp one in. Guests can't write, so
 * they see the old image until a member's kitchen view upgrades it.
 */
export function useCoverUpgrade(recipes: Recipe[], enabled: boolean): void {
  useEffect(() => {
    if (!enabled) return
    for (const recipe of recipes) {
      const cover = recipe.cover
      if (!cover || coversChecked.has(recipe.id)) continue
      coversChecked.add(recipe.id)
      void (async () => {
        if (!(await isLegacyCoverThumb(cover.thumb))) return
        const full = await fetchPhoto(cover.photo)
        if (!full) return
        await setRecipeCover(recipe.slug, { photo: cover.photo, thumb: await coverThumbFromDataUrl(full) })
      })().catch(() => {
        // Best effort — the old image still shows; try again next session.
      })
    }
  }, [recipes, enabled])
}

/**
 * Save edits to an existing recipe in place, keyed by its slug (the doc id, so
 * the URL never changes even if the title does). A merge write overwrites the
 * edited fields while leaving householdId, createdBy, and createdAt untouched.
 * Editing in the app claims ownership: origin becomes 'app' so the retired
 * recipe restore (were it ever run) and any prune leave the edit alone. Rules
 * allow this only for members of the recipe's household.
 */
export async function updateRecipe(seed: RecipeSeed, { approve = false } = {}): Promise<string> {
  await setDoc(
    doc(db, 'recipes', seed.slug),
    {
      ...seed,
      origin: 'app',
      updatedAt: serverTimestamp(),
      // Saved from review: it joins the kitchen with the edits.
      ...(approve ? { inReview: deleteField(), review: deleteField() } : {}),
    },
    { merge: true },
  )
  return seed.slug
}
