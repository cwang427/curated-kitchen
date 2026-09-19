import { auth } from '../lib/firebase'
import { URL_IMPORT_URL } from '../lib/aiConfig'
import { parseRecipe } from '../lib/recipeSchema'
import { recipeFromJsonLd, slugify } from '../lib/importRecipe'
import type { RecipeSeed } from '../lib/types'

/**
 * Import a recipe from a link. The Worker fetches the page server-side (the app
 * can't, because of CORS) and returns the schema.org JSON-LD most recipe sites
 * embed. We convert that to our shape with the SAME pure `recipeFromJsonLd` the
 * old CI importer used, then validate with the SAME zod schema — so a link
 * import lands in the editor for review exactly like a paste or a photo. No AI,
 * no cost: reading structured data is deterministic.
 */

export interface UrlImportResult {
  seed: RecipeSeed
  warnings: string[]
}

function randomSuffix(): string {
  return Math.random().toString(36).slice(2, 7)
}

/** Drop empty-string values so optional fields don't trip the validator. */
function stripEmpty<T>(value: T): T {
  return JSON.parse(JSON.stringify(value, (_key, v) => (v === '' ? undefined : v)))
}

export async function importRecipeFromUrl(url: string): Promise<UrlImportResult> {
  if (!URL_IMPORT_URL) throw new Error('Link import isn’t set up yet.')
  const user = auth.currentUser
  if (!user) throw new Error('Sign in first.')
  const token = await user.getIdToken()

  const res = await fetch(URL_IMPORT_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ url }),
  })
  const data = (await res.json().catch(() => ({}))) as {
    jsonld?: unknown
    url?: string
    error?: string
  }
  if (!res.ok) throw new Error(data.error || `Import failed (${res.status}).`)
  if (!data.jsonld) throw new Error('No recipe data found on that page.')

  // recipeFromJsonLd throws a clear message if the page has no Recipe markup.
  const { recipe, warnings } = recipeFromJsonLd(data.jsonld, data.url || url)
  const clean = stripEmpty(recipe) as Record<string, unknown>
  const title = typeof clean.title === 'string' ? clean.title : ''
  const withSlug = { ...clean, slug: `${slugify(title) || 'recipe'}-${randomSuffix()}` }

  const parsed = parseRecipe(withSlug)
  return { seed: parsed.recipe, warnings: [...warnings, ...parsed.warnings] }
}
