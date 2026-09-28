import cacio from '../../recipes/cacio-e-pepe.json'
import { parseRecipe } from '../../src/lib/recipeSchema'
import type { RecipeSeed } from '../../src/lib/types'

export interface LinkReport {
  via?: string
  photosUnavailable?: boolean
  retryAfterMs?: number
  photos?: { wanted: number; got: number }
}
export interface AiImportResult {
  seed: RecipeSeed
  warnings: string[]
  link?: LinkReport
}
export type ImportError = Error & {
  status?: number
  code?: string
  detail?: string
  retryAfterMs?: number
}
export type AiPhoto = { data: string; mediaType: string }
export type AiInput = { text: string } | { images: AiPhoto[] } | { url: string }

const fail = (message: string, extra: Partial<ImportError>): never => {
  throw Object.assign(new Error(message), extra)
}

/** Preview: return a real parsed recipe after a short "reading" delay. A link
 * naming one of these shows that outcome instead:
 *   busy          nothing readable while the Archive is busy (Try again in 1:30)
 *   nophotos      recipe but no photos, Archive busy (choice, Try again in 1:30)
 *   blockedphotos recipe but no photos, nothing to wait for (editor + note)
 *   nopics        the photo downloads all failed (choice, Try again now)
 *   somepics      3 of 5 photos in time (editor + note)
 *   aibusy        the AI overloaded (Try again only)
 *   nyt           a site that refuses everything */
export async function importRecipeViaAI(input?: AiInput): Promise<AiImportResult> {
  await new Promise((r) => setTimeout(r, 400))
  const url = input && 'url' in input ? input.url : ''
  if (url.includes('busy') && !url.includes('aibusy')) {
    fail('seriouseats.com blocks direct imports, and its saved copy at the Internet Archive is busy right now.', {
      status: 422,
      code: 'archive_busy',
      retryAfterMs: 90_000,
    })
  }
  if (url.includes('aibusy')) fail('Our recipe reader (Google’s AI) is overloaded right now, so it couldn’t finish this one.', { status: 502, code: 'ai_busy' })
  if (url.includes('nyt')) {
    fail('NYT Cooking recipes are for subscribers only, so the app can’t open the link — copy the recipe text (or take a screenshot) and add it that way.', {
      status: 422,
      code: 'site_refuses',
    })
  }
  const { recipe, warnings } = parseRecipe(cacio)
  const link: LinkReport | undefined = !url
    ? undefined
    : url.includes('nophotos')
      ? { via: 'google-archive', photosUnavailable: true, retryAfterMs: 90_000 }
      : url.includes('blockedphotos')
        ? { via: 'google', photosUnavailable: true }
        : url.includes('nopics')
          ? { via: 'archive', photos: { wanted: 4, got: 0 } }
          : url.includes('somepics')
            ? { via: 'archive', photos: { wanted: 5, got: 3 } }
            : { via: 'direct', photos: { wanted: 2, got: 2 } }
  return { seed: recipe, warnings, link }
}
