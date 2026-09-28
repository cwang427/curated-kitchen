import cacio from '../../recipes/cacio-e-pepe.json'
import { parseRecipe } from '../../src/lib/recipeSchema'
import type { RecipeSeed } from '../../src/lib/types'

export interface AiImportResult {
  seed: RecipeSeed
  warnings: string[]
}
export type AiPhoto = { data: string; mediaType: string }
export type AiInput = { text: string } | { images: AiPhoto[] } | { url: string }

let busyTries = 0

/** Preview: return a real parsed recipe after a short "reading" delay. A link
 * containing "busy<N>" answers "Internet Archive busy" N times first ("busyall":
 * every time), to show the app's wait-and-retry. */
export async function importRecipeViaAI(input?: AiInput): Promise<AiImportResult> {
  await new Promise((r) => setTimeout(r, 400))
  const busy = input && 'url' in input ? input.url.match(/busy(\d+|all)/)?.[1] : undefined
  if (busy && (busy === 'all' || busyTries < Number(busy))) {
    busyTries++
    throw Object.assign(
      new Error(
        'seriouseats.com blocks direct imports, and its saved copy at the Internet Archive is busy right now — try again in a few minutes, or paste the recipe text instead.',
      ),
      { status: 422, code: 'archive_busy', detail: 'archive busy; URL_RETRIEVAL_STATUS_ERROR' },
    )
  }
  busyTries = 0
  const { recipe, warnings } = parseRecipe(cacio)
  return { seed: recipe, warnings }
}
