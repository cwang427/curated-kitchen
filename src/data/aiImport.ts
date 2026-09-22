import { auth } from '../lib/firebase'
import { AI_IMPORT_URL } from '../lib/aiConfig'
import { parseRecipe } from '../lib/recipeSchema'
import { slugify } from '../lib/importRecipe'
import { sanitizeAiRecipe } from '../lib/aiRecipe'
import type { RecipeSeed } from '../lib/types'

/**
 * Turn a pasted recipe or one-or-more photos into our structured shape, via the import
 * Worker (which holds the API key — Gemini's free tier by default). The Worker
 * returns the model's best-effort structured recipe; we then run it through the
 * SAME zod validator CI uses, so nothing malformed ever reaches the preview or
 * the database.
 */

export type AiPhoto = { data: string; mediaType: string }
/** Text paste, or one-or-more photos of the SAME recipe (a long recipe often
 * needs several phone screenshots), read together into one result. */
export type AiInput = { text: string } | { images: AiPhoto[] }

export interface AiImportResult {
  seed: RecipeSeed
  warnings: string[]
}

function randomSuffix(): string {
  return Math.random().toString(36).slice(2, 7)
}

/** Name the first thing the validator objected to, in words, instead of zod's
 * raw JSON dump — enough for the owner to report back what went wrong. */
function describeInvalid(cause: unknown): string {
  const issue = (cause as { issues?: Array<{ path: Array<string | number>; message: string }> })
    .issues?.[0]
  const detail = issue
    ? `${issue.path.join('.') || 'recipe'}: ${issue.message}`
    : cause instanceof Error
      ? cause.message
      : String(cause)
  return `The AI read it, but part of its answer didn’t fit our recipe format (${detail}). Try again, or use Paste text.`
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

  // Fill gaps (e.g. no servings) and drop pieces the strict validator would
  // reject, so one slip doesn't sink an otherwise good import.
  const raw = sanitizeAiRecipe(data.recipe)
  const title = raw.title as string
  const source = raw.source as { url?: string }
  // The model can invent a plausible-but-wrong source link (it guessed a Serious
  // Eats URL from pasted text that had none, and it 404'd). Trust a URL only if
  // it's a real http(s) link AND literally appears in the text we sent — a photo
  // has no text to verify against. Better no link than a broken one; the cook
  // can always paste the real URL in the editor.
  const providedText = 'text' in input ? input.text : ''
  if (source.url && (!/^https?:\/\//i.test(source.url) || !providedText.includes(source.url))) {
    delete source.url
  }
  // Recipes are keyed by a global slug; give this one a fresh unique one.
  const withSlug = { ...raw, slug: `${slugify(title) || 'recipe'}-${randomSuffix()}` }

  try {
    const { recipe, warnings } = parseRecipe(withSlug)
    return { seed: recipe, warnings }
  } catch (cause) {
    throw new Error(describeInvalid(cause))
  }
}
