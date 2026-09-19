import { auth } from '../lib/firebase'
import { AI_IMPORT_URL } from '../lib/aiConfig'
import { parseRecipe } from '../lib/recipeSchema'
import { slugify } from '../lib/importRecipe'
import type { RecipeSeed } from '../lib/types'

/**
 * Turn a pasted recipe or a photo into our structured shape, via the import
 * Worker (which holds the API key). The Worker returns Claude's best-effort
 * structured recipe; we then run it through the SAME zod validator CI uses, so
 * nothing malformed ever reaches the preview or the database.
 */

export type AiInput = { text: string } | { image: { data: string; mediaType: string } }

export interface AiImportResult {
  seed: RecipeSeed
  warnings: string[]
}

function randomSuffix(): string {
  return Math.random().toString(36).slice(2, 7)
}

/** Drop empty-string values so optional fields (e.g. an unset source url) don't
 * trip the validator, which requires non-empty strings. */
function stripEmpty<T>(value: T): T {
  return JSON.parse(JSON.stringify(value, (_key, v) => (v === '' ? undefined : v)))
}

export async function importRecipeViaAI(input: AiInput): Promise<AiImportResult> {
  if (!AI_IMPORT_URL) throw new Error('AI import isn’t set up yet.')
  const user = auth.currentUser
  if (!user) throw new Error('Sign in first.')
  const token = await user.getIdToken()

  const res = await fetch(AI_IMPORT_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(input),
  })
  const data = (await res.json().catch(() => ({}))) as { recipe?: unknown; error?: string }
  if (!res.ok) throw new Error(data.error || `Import failed (${res.status}).`)
  if (!data.recipe) throw new Error('The AI didn’t return a recipe.')

  const raw = stripEmpty(data.recipe) as Record<string, unknown>
  const title = typeof raw.title === 'string' ? raw.title : ''
  const source = raw.source as { url?: string } | undefined
  if (source?.url && !/^https?:\/\//i.test(source.url)) delete source.url
  // Recipes are keyed by a global slug; give this one a fresh unique one.
  const withSlug = { ...raw, slug: `${slugify(title) || 'recipe'}-${randomSuffix()}` }

  const { recipe, warnings } = parseRecipe(withSlug)
  return { seed: recipe, warnings }
}
