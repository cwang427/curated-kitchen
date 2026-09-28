import { auth } from '../lib/firebase'
import { AI_IMPORT_URL } from '../lib/aiConfig'
import { parseRecipe } from '../lib/recipeSchema'
import { slugify } from '../lib/importRecipe'
import { sanitizeAiRecipe } from '../lib/aiRecipe'
import { compressToDataUrl, makeCoverThumb } from './photos'
import { seedFromJsonLd } from './urlImport'
import type { RecipeSeed } from '../lib/types'

/**
 * Turn a pasted recipe or one-or-more photos into our structured shape, via the import
 * Worker (which holds the API key — Gemini's free tier by default). The Worker
 * returns the model's best-effort structured recipe; we then run it through the
 * SAME zod validator CI uses, so nothing malformed ever reaches the preview or
 * the database.
 */

export type AiPhoto = { data: string; mediaType: string }
/** Text paste, one-or-more photos/PDFs of the SAME recipe (a long recipe often
 * needs several phone screenshots) read together into one result, or a link —
 * which Gemini reads itself through Google, so sites that block our Worker's
 * own fetch still work. */
export type AiInput = { text: string } | { images: AiPhoto[] } | { url: string }

export interface AiImportResult {
  seed: RecipeSeed
  warnings: string[]
  /** For a link: how it was read and how its photos went. */
  link?: LinkReport
}

export interface LinkReport {
  /** Which route read the page ('direct', 'reader', 'archive', 'google', …). */
  via?: string
  /** The recipe was read without its page (Google's reader), so without photos. */
  photosUnavailable?: boolean
  /** Trying again after this long could bring the photos too (the Archive was
   * only busy). Absent when trying again wouldn't help. */
  retryAfterMs?: number
  /** Photos the page had, and how many came through in time. */
  photos?: { wanted: number; got: number }
}

/** A failed import, with what the Worker said about why. */
export type ImportError = Error & {
  status?: number
  /** 'archive_busy' | 'ai_busy' | 'site_refuses' | 'not_a_recipe' … */
  code?: string
  detail?: string
  retryAfterMs?: number
  /** With 'ai_busy': the page's own recipe data, for a simpler import. */
  jsonld?: unknown
  photos?: LinkPhotos
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
  const data = (await res.json().catch(() => ({}))) as {
    recipe?: unknown
    error?: string
    code?: string
    detail?: string
    retryAfterMs?: number
    jsonld?: unknown
    photos?: LinkPhotos
    via?: string
    photosUnavailable?: boolean
  }
  if (!res.ok) {
    // Keep what the Worker said: the status (a 422 means it already tried every
    // way it has), and `code` for why — e.g. the Internet Archive was only busy,
    // worth trying again after `retryAfterMs`.
    const error: ImportError = Object.assign(new Error(data.error || `Import failed (${res.status}).`), {
      status: res.status,
      code: data.code,
      detail: data.detail,
      retryAfterMs: data.retryAfterMs,
      jsonld: data.jsonld,
      photos: data.photos,
    })
    throw error
  }
  if (!data.recipe) throw new Error('The AI didn’t return a recipe.')

  // Fill gaps (e.g. no servings) and drop pieces the strict validator would
  // reject, so one slip doesn't sink an otherwise good import.
  const raw = sanitizeAiRecipe(data.recipe)
  const title = raw.title as string
  const source = raw.source as { url?: string }
  // The model can invent a plausible-but-wrong source link (it guessed a Serious
  // Eats URL from pasted text that had none, and it 404'd). For a link import
  // the source is simply the link the cook gave us. Otherwise trust a URL only
  // if it's a real http(s) link AND literally appears in the text we sent — a
  // photo has no text to verify against. Better no link than a broken one; the
  // cook can always paste the real URL in the editor.
  if ('url' in input) {
    source.url = input.url
  } else {
    const providedText = 'text' in input ? input.text : ''
    if (source.url && (!/^https?:\/\//i.test(source.url) || !providedText.includes(source.url))) {
      delete source.url
    }
  }
  // Recipes are keyed by a global slug; give this one a fresh unique one.
  const withSlug = { ...raw, slug: `${slugify(title) || 'recipe'}-${randomSuffix()}` }

  let parsed: AiImportResult
  try {
    const { recipe, warnings } = parseRecipe(withSlug)
    parsed = { seed: recipe, warnings }
  } catch (cause) {
    throw new Error(describeInvalid(cause))
  }
  if ('url' in input) {
    parsed.link = {
      via: data.via,
      photosUnavailable: data.photosUnavailable,
      retryAfterMs: data.retryAfterMs,
      photos: data.photos ? await attachLinkPhotos(parsed.seed, data.photos, token) : undefined,
    }
  }
  return parsed
}

/**
 * The AI was busy, but the Worker had the page and handed back its recipe data
 * (error code 'ai_busy'): the recipe as the site lists it — steps as written,
 * aisles guessed, no cook-mode summaries — plus its cover photo. Only when the
 * cook chooses it over trying again.
 */
export async function importFromRecipeData(error: ImportError, url: string): Promise<AiImportResult> {
  const user = auth.currentUser
  if (!user) throw new Error('Sign in first.')
  const result: AiImportResult = seedFromJsonLd(error.jsonld, url)
  result.seed.source = { ...result.seed.source, url }
  // Step photos only if our reading of the recipe data has the same steps as
  // the Worker's (so each photo lands on its own step); the cover regardless.
  const photos = error.photos
  const sameSteps = photos?.stepCount === result.seed.steps.length
  const wanted = photos && (sameSteps ? photos : { ...photos, steps: {}, stepCandidates: {} })
  result.link = { via: 'recipe data', photos: wanted ? await attachLinkPhotos(result.seed, wanted, await user.getIdToken()) : undefined }
  return result
}

/** Photo links a link import found on the page (see the Worker's findLinkPhotos):
 * the cover — as a few candidates, other sizes of the same photo, best first
 * (`cover` alone from a Worker older than 0.41.4) — and, when the AI kept the
 * page's steps, photos per step index (each with its own candidates from a
 * Worker 0.42.2+). */
type LinkPhotos = {
  cover: string | null
  covers?: string[]
  steps: Record<string, string[]>
  /** Each step photo's other sizes to try, best first (Worker 0.42.2+). */
  stepCandidates?: Record<string, string[][]>
  stamp?: string
  /** The Worker can fetch a photo through Firecrawl, as a last resort (0.47+). */
  unlocker?: boolean
  /** With 'ai_busy': how many steps the page's recipe data has (0.48+). */
  stepCount?: number
}

/** A photo from Firecrawl comes as JSON with the bytes in base64 (the Worker
 * passes it through untouched — decoding is too heavy for its free plan). */
async function fileFromUnlocker(res: Response): Promise<File | null> {
  const body = (await res.json().catch(() => null)) as {
    success?: boolean
    data?: { rawBase64?: string; metadata?: { statusCode?: number; contentType?: string } }
  } | null
  const data = body?.data
  const type = data?.metadata?.contentType ?? 'image/jpeg'
  if (!body?.success || !data?.rawBase64 || (data.metadata?.statusCode ?? 200) >= 400 || !type.startsWith('image/')) return null
  const bin = atob(data.rawBase64)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return new File([bytes], 'photo', { type })
}

/** Photos get this long in all; the editor then opens with whatever arrived
 * (and says what didn't), rather than a slow image host holding the import.
 * A little longer when Firecrawl is the last resort — it's slower. */
const PHOTO_DEADLINE_MS = 15_000
const PHOTO_DEADLINE_UNLOCKER_MS = 22_000

/**
 * Bring a link import's photos in as unsaved photos on the preview (data URLs,
 * compressed like any photo you add), so the cook sees them in the editor and
 * saving stores them as photo docs. Each photo streams through the Worker's
 * /img route — the browser can't fetch another site's image itself. Best-effort
 * and bounded: a photo that won't come through in time is left out, and the
 * report says how many made it.
 */
async function attachLinkPhotos(
  seed: RecipeSeed,
  photos: LinkPhotos,
  token: string,
): Promise<{ wanted: number; got: number }> {
  const allowed = photos.unlocker ? PHOTO_DEADLINE_UNLOCKER_MS : PHOTO_DEADLINE_MS
  const deadline = Date.now() + allowed
  const inflight = new Set<AbortController>()
  let closed = false
  /** One photo through the Worker's /img; `paid` = through Firecrawl. */
  const download = async (url: string, paid = false): Promise<File | null> => {
    const left = Math.min(deadline - Date.now(), paid ? 15_000 : 12_000)
    if (left <= 0 || closed) return null
    const controller = new AbortController()
    inflight.add(controller)
    const timer = setTimeout(() => controller.abort(), left)
    try {
      const res = await fetch(`${AI_IMPORT_URL}/img`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ url, stamp: photos.stamp, ...(paid ? { paid: true } : {}) }),
        signal: controller.signal,
      })
      if (!res.ok) return null
      if (paid) return await fileFromUnlocker(res)
      const blob = await res.blob()
      return new File([blob], 'photo', { type: blob.type || 'image/jpeg' })
    } catch {
      return null
    } finally {
      clearTimeout(timer)
      inflight.delete(controller)
    }
  }
  // Three at a time. (It used to be one at a time for an Archive-read page:
  // photos then came from the Archive via our Worker's shared addresses, which
  // the Archive rations. They now come through the image proxy's own servers —
  // the Worker's /img — so there's no allowance of ours to protect.)
  type Job = { kind: 'cover'; urls: string[] } | { kind: 'step'; index: number; slot: number; urls: string[] }
  const covers = photos.covers?.length ? photos.covers.slice(0, 4) : photos.cover ? [photos.cover] : []
  const jobs: Job[] = [
    ...(covers.length ? [{ kind: 'cover' as const, urls: covers }] : []),
    ...Object.entries(photos.steps ?? {}).flatMap(([index, urls]) =>
      urls.slice(0, 3).map((url, slot) => ({
        kind: 'step' as const,
        index: Number(index),
        slot,
        urls: photos.stepCandidates?.[index]?.[slot]?.length ? photos.stepCandidates[index][slot] : [url],
      })),
    ),
  ]
  // Each photo keeps its slot, so two parallel downloads can't swap a step's order.
  const stepPhotos = new Map<number, (string | undefined)[]>()
  let got = 0
  const run = async (job: Job) => {
    // The first candidate that downloads and decodes wins: each photo comes as
    // a few sizes, because the Archive often lacks the size the recipe data
    // names (it only saves the sizes a page displayed). If every free route
    // failed, one last try of the best size through Firecrawl — once per
    // photo, so a photo costs at most one credit.
    const tries = [...job.urls.map((url) => ({ url, paid: false })), ...(photos.unlocker && job.urls[0] ? [{ url: job.urls[0], paid: true }] : [])]
    for (const { url, paid } of tries) {
      const file = await download(url, paid)
      if (!file) continue
      try {
        if (job.kind === 'cover') {
          const [photo, thumb] = await Promise.all([compressToDataUrl(file), makeCoverThumb(file)])
          if (closed) return
          seed.cover = { photo, thumb }
        } else {
          const image = await compressToDataUrl(file)
          if (closed) return
          // Look the list up only after the await, or two downloads for one step
          // could each start a fresh list and the second would drop the first.
          const list = stepPhotos.get(job.index) ?? []
          list[job.slot] = image
          stepPhotos.set(job.index, list)
        }
        got++
        return
      } catch {
        /* unreadable image — try the next candidate, if any */
      }
    }
  }
  let next = 0
  const worker = async () => {
    while (next < jobs.length && !closed) await run(jobs[next++])
  }
  // Past the deadline (plus a moment to finish shrinking a photo that just
  // arrived), stop: call off what's still downloading and keep what we have.
  let stop: ReturnType<typeof setTimeout> | undefined
  await Promise.race([
    Promise.all(Array.from({ length: 3 }, worker)),
    new Promise<void>((resolve) => (stop = setTimeout(resolve, allowed + 1_500))),
  ])
  clearTimeout(stop)
  closed = true
  for (const controller of inflight) controller.abort()
  for (const [index, slots] of stepPhotos) {
    const step = seed.steps[index]
    const images = slots.filter((x): x is string => !!x)
    if (step && images.length) step.images = images
  }
  return { wanted: jobs.length, got }
}
