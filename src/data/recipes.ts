import { useEffect, useMemo, useState } from 'react'
import {
  collection,
  doc,
  onSnapshot,
  query,
  where,
  type DocumentData,
} from 'firebase/firestore'
import { db } from '../lib/firebase'
import { SCHEMA_VERSION, type Recipe } from '../lib/types'

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
    steps: data.steps ?? [],
    groups: data.groups ?? [],
    tags: data.tags ?? [],
    equipment: data.equipment ?? [],
    notes: data.notes ?? [],
    images: data.images ?? [],
    householdId: data.householdId ?? null,
    visibility: data.visibility ?? 'household',
    createdBy: data.createdBy ?? null,
    createdAt: toMillis(data.createdAt),
    updatedAt: toMillis(data.updatedAt),
  }
}

export interface RecipesState {
  recipes: Recipe[]
  loading: boolean
  error: string | null
}

export function useRecipes(householdId: string | null, nonce = 0): RecipesState {
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
    // every document returned belongs to a household the user is a member of.
    //
    // Sorting happens below rather than via orderBy() on purpose: a filter
    // plus an orderBy needs a composite index, which is one more thing to
    // create before the app works. Everything is already in memory for search.
    const q = query(collection(db, 'recipes'), where('householdId', '==', householdId))

    return onSnapshot(
      q,
      (snapshot) => {
        setRecipes(
          snapshot.docs
            .map((d) => toRecipe(d.id, d.data()))
            .sort((a, b) => a.title.localeCompare(b.title)),
        )
        setError(null)
        setLoading(false)
      },
      (cause) => {
        setError(cause.message)
        setLoading(false)
      },
    )
  }, [householdId, nonce])

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
      if (tags.length > 0 && !tags.every((tag) => recipe.tags.includes(tag))) {
        return false
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

export function collectTags(recipes: Recipe[]): string[] {
  const counts = new Map<string, number>()
  for (const recipe of recipes) {
    for (const tag of recipe.tags) counts.set(tag, (counts.get(tag) ?? 0) + 1)
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([tag]) => tag)
}
