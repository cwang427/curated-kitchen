/**
 * Curated Kitchen — recipe-ingestion Worker.
 *
 * A tiny Cloudflare Worker that holds the Anthropic API key (which must NEVER
 * live in the app, since the app is public) and turns a pasted recipe or a photo
 * into our structured recipe shape. The app POSTs { text } or { images } (one or
 * more photos of the same recipe) here with the caller's Firebase ID token; the
 * legacy single { image } is still accepted. The Worker verifies that token (so only
 * signed-in household members can spend your key), calls Claude with a strict
 * tool that mirrors our recipe schema, and returns the structured JSON. The app
 * then validates it with the same zod schema CI uses before anything is saved.
 *
 * See worker/README.md for deploy steps and the secrets/vars it needs.
 */

// The app's fixed tag list — one source of truth. wrangler bundles this file in
// from the app's src/ (it has no React/DOM dependencies).
import { ALL_TAGS, TAG_GROUPS } from '../../src/lib/tags'

interface Env {
  FIREBASE_PROJECT_ID: string
  ALLOWED_ORIGIN?: string
  // AI import (paste text / a photo). The free /url route needs none of these.
  // Preferred: Google Gemini's FREE tier — set GEMINI_API_KEY (a secret) and the
  // AI route uses Gemini. GEMINI_MODEL overrides the default model.
  GEMINI_API_KEY?: string
  GEMINI_MODEL?: string
  // Optional, paid alternative: Anthropic Claude. Used only if GEMINI_API_KEY is
  // not set. Kept so the paid route stays available if ever wanted.
  ANTHROPIC_API_KEY?: string
  ANTHROPIC_MODEL?: string
  // Optional: the Worker's Internet Archive sign-in — the two session cookies,
  // as one Cookie header value. A secret, set by `npm run archive:login` (never
  // by hand, never in wrangler.toml). The Archive's Sept 2026 access update:
  // signed-in users don't get its 429 "too many requests".
  ARCHIVE_COOKIES?: string
}

const GROCERY_CATEGORIES = [
  'produce', 'meat', 'seafood', 'dairy', 'bakery', 'deli', 'frozen', 'pantry',
  'spices', 'condiments', 'baking', 'beverages', 'alcohol', 'household', 'other',
]

/** The tool Claude must call — a loose mirror of RecipeInput. The app's zod
 * schema is the real validator, so this stays forgiving (no strict mode). */
const RECIPE_TOOL = {
  name: 'save_recipe',
  description: 'Return the recipe as structured data in Curated Kitchen’s format.',
  input_schema: {
    type: 'object',
    properties: {
      title: { type: 'string', description: 'Recipe name.' },
      subtitle: { type: 'string' },
      description: { type: 'string', description: 'A short headnote, if any.' },
      source: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Publication, e.g. "Serious Eats".' },
          author: { type: 'string' },
          url: { type: 'string' },
        },
      },
      yield: {
        type: 'object',
        properties: {
          amount: { type: 'number' },
          amountMax: { type: 'number', description: 'Upper bound if a range, else omit.' },
          unit: { type: 'string', description: 'e.g. "servings", "cookies".' },
        },
        required: ['amount'],
      },
      times: {
        type: 'object',
        properties: {
          prepMin: { type: 'number' },
          cookMin: { type: 'number' },
          totalMin: { type: 'number' },
          activeMin: { type: 'number', description: 'Hands-on minutes.' },
        },
      },
      ingredients: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            quantity: { type: 'number', description: 'null/omit for "to taste".' },
            quantityMax: { type: 'number', description: 'Upper bound of a range like "2–3".' },
            unit: { type: 'string', description: 'Standard abbrev: tsp, tbsp, cup, g, kg, oz, lb, ml, l, clove. Omit for countable items ("2 eggs").' },
            item: { type: 'string', description: 'Singular display name, e.g. "yellow onion".' },
            prep: { type: 'string', description: 'e.g. "finely diced", "at room temperature".' },
            note: { type: 'string', description: 'Non-numeric aside, e.g. "plus more for serving".' },
            optional: { type: 'boolean' },
            scalable: { type: 'boolean', description: 'false for "salt to taste", "oil for frying".' },
            category: { type: 'string', enum: GROCERY_CATEGORIES, description: 'Supermarket aisle.' },
            alt: {
              type: 'object',
              description: 'A parallel measurement shown in parentheses, e.g. the "12 oz" in "340 g (12 oz)".',
              properties: { quantity: { type: 'number' }, unit: { type: 'string' } },
            },
          },
          required: ['item', 'category'],
        },
      },
      steps: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            text: { type: 'string', description: 'Full step prose. Wrap scalable amounts in {{ }} tokens, e.g. "Add {{2 tbsp}} butter". Leave times/temperatures as plain text.' },
            brief: { type: 'array', items: { type: 'string' }, description: 'Optional concise one-action-per-line version of text; may also use {{ }} tokens.' },
            timers: {
              type: 'array',
              items: {
                type: 'object',
                properties: { label: { type: 'string' }, seconds: { type: 'number' } },
                required: ['label', 'seconds'],
              },
            },
            temperature: {
              type: 'object',
              properties: {
                value: { type: 'number' },
                unit: { type: 'string', enum: ['F', 'C'] },
                mode: { type: 'string', enum: ['oven', 'internal', 'oil', 'surface', 'water', 'other'] },
              },
            },
            handsOff: { type: 'boolean', description: 'true if this step is a mostly-unattended wait the cook can step away from (simmer, bake, roast, braise, chill, rest, marinate, proof, reduce); false if it needs active attention (stir/whisk constantly, watch closely) or is a quick action. Omit if unclear.' },
          },
          required: ['text'],
        },
      },
      tags: {
        type: 'array',
        // Only the app's fixed list (src/lib/tags.ts) — anything else cluttered
        // the kitchen's filter row. The app normalizes again on arrival.
        items: { type: 'string', enum: ALL_TAGS },
        description: 'Browsing labels from the allowed list only: the course, the cuisine, the kind of dish, any dietary fit that clearly applies, and weeknight/make-ahead/holiday if the recipe says so. Usually 2–4. Never ingredients, methods or equipment.',
      },
      equipment: {
        type: 'array',
        items: { type: 'string' },
        description: 'Notable tools the recipe calls for, e.g. "12-inch skillet", "food processor", "Dutch oven". Only what the recipe names or clearly requires; omit if nothing stands out.',
      },
      notes: {
        type: 'array',
        items: { type: 'string' },
        description: 'Tips / make-ahead / storage / variation asides from the source (e.g. a "Recipe Tip" or "Notes" section), one per entry. Only what the source actually says.',
      },
      not_a_recipe: { type: 'boolean', description: 'Set true if the input is not actually a recipe.' },
    },
    required: ['title', 'ingredients', 'steps'],
  },
} as const

const SYSTEM = `You convert recipes into Curated Kitchen's structured format by calling the save_recipe tool. Be faithful to the source — never invent ingredients, amounts, times, or steps that aren't there, and never drop any. Keep the original wording of steps; only restructure amounts into {{ }} tokens.

Rules:
- Ingredients are structured: split each line into quantity, unit, item (singular), and prep. Use standard unit abbreviations (tsp, tbsp, cup, g, kg, oz, lb, ml, l, clove). For a countable thing ("2 eggs"), give quantity 2 and no unit. For "salt to taste", set quantity null and scalable false. Ranges like "2–3 cloves" → quantity 2, quantityMax 3.
- A parenthetical second measurement ("340 g bucatini (12 oz)") goes in "alt" so it scales too.
- Every ingredient needs a "category" (supermarket aisle) from the allowed list.
- Keep the source's step boundaries: each numbered or separate step in the source becomes exactly one step, in order — never merge steps together or split one apart.
- In step text, wrap amounts that should scale with servings in {{ }} (e.g. "Add {{2 tbsp}} of the butter"). Leave times and temperatures as plain text. Put oven temps in the step's temperature field as well.
- For EVERY step, also fill "brief": a scannable cook-mode version of that same step, one action per line (an array of short lines). Reuse the same {{ }} tokens for scalable amounts. This is a condensed restatement of the step's own text — keep the full prose in "text"; never let an instruction appear only in "brief".
- Set "handsOff" true on a step that's a mostly-unattended wait the cook can step away from (simmer, bake, roast, braise, chill, rest, marinate, proof, reduce), and false on one that needs active attention (stir/whisk constantly, watch closely) or is a quick action. Omit if unclear.
- Fill "equipment" with the notable tools the recipe uses (skillet, food processor, pressure cooker, etc.) when it names or clearly requires them. Don't invent specifics the recipe doesn't imply.
- Fill "notes" with any tips, make-ahead, storage, or variation asides the source includes (e.g. a "Recipe Tip" or "Notes" section). Don't invent notes that aren't there.
- Fill the top-level metadata whenever the source shows it: title, subtitle, description (the headnote), source.name (the site or publication), source.author (the byline), source.url (only if a URL actually appears in the text), yield, and prep/cook/total times. Leave any field blank rather than guessing.
- "tags" come ONLY from this list: ${TAG_GROUPS.map((g) => `${g.label.toLowerCase()}: ${g.tags.join(', ')}`).join('; ')}. Pick the course (a main dish is "mains"), the cuisine (a regional style counts as its country — Roman is "italian", Sichuan is "chinese"), the kind of dish if it's one of those, "vegetarian"/"vegan"/"pescatarian"/"gluten-free"/"dairy-free" only when the whole recipe qualifies, and an occasion only if the recipe says so. Usually 2–4 tags. Never tag ingredients (beef, pork), methods (braise), or equipment (pressure cooker) — search already finds those.
- If the input clearly isn't a recipe, call save_recipe with not_a_recipe true and empty ingredients/steps.`

function corsHeaders(origin: string): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age': '86400',
  }
}

function json(body: unknown, status: number, origin: string): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) },
  })
}

/* ---- Firebase ID token verification (RS256 against Google's JWKS) ---- */

function b64urlToBytes(s: string): Uint8Array {
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4))
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + pad
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

async function verifyFirebaseToken(token: string, projectId: string): Promise<string | null> {
  const parts = token.split('.')
  if (parts.length !== 3) return null
  const [headerB64, payloadB64, sigB64] = parts

  let header: { kid?: string; alg?: string }
  let payload: { aud?: string; iss?: string; exp?: number; iat?: number; sub?: string }
  try {
    header = JSON.parse(new TextDecoder().decode(b64urlToBytes(headerB64)))
    payload = JSON.parse(new TextDecoder().decode(b64urlToBytes(payloadB64)))
  } catch {
    return null
  }

  const now = Math.floor(Date.now() / 1000)
  if (header.alg !== 'RS256' || !header.kid) return null
  if (payload.aud !== projectId) return null
  if (payload.iss !== `https://securetoken.google.com/${projectId}`) return null
  if (!payload.sub) return null
  if (!payload.exp || payload.exp < now) return null
  if (payload.iat && payload.iat > now + 300) return null

  // Google publishes the current signing keys as JWKS.
  const jwks = await fetch(
    'https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com',
  ).then((r) => r.json() as Promise<{ keys: Array<Record<string, string>> }>)
  const jwk = jwks.keys.find((k) => k.kid === header.kid)
  if (!jwk) return null

  const key = await crypto.subtle.importKey(
    'jwk',
    { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: 'RS256', ext: true },
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['verify'],
  )
  const ok = await crypto.subtle.verify(
    'RSASSA-PKCS1-v1_5',
    key,
    b64urlToBytes(sigB64) as BufferSource,
    new TextEncoder().encode(`${headerB64}.${payloadB64}`) as BufferSource,
  )
  return ok ? payload.sub : null
}

/* ---- Free URL import: fetch a page and pull its schema.org JSON-LD ---- */

/** Block loopback / private / link-local hosts so the fetcher can't be pointed
 * at internal addresses (basic SSRF hygiene; only members can call it anyway). */
function isBlockedHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, '')
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal')) {
    return true
  }
  if (h === '::1' || h.startsWith('fd') || h.startsWith('fe80')) return true
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(h)) {
    const p = h.split('.').map(Number)
    if (p[0] === 10 || p[0] === 127 || p[0] === 0) return true
    if (p[0] === 169 && p[1] === 254) return true // link-local / cloud metadata
    if (p[0] === 172 && p[1] >= 16 && p[1] <= 31) return true
    if (p[0] === 192 && p[1] === 168) return true
  }
  return false
}

/** Pull the contents of every <script type="application/ld+json"> block. */
function extractJsonLd(html: string): unknown[] {
  const out: unknown[] = []
  const re = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi
  let m: RegExpExecArray | null
  while ((m = re.exec(html)) !== null) {
    let text = m[1].trim()
    if (!text) continue
    text = text.replace(/^<!\[CDATA\[/, '').replace(/\]\]>$/, '').trim()
    try {
      out.push(JSON.parse(text))
    } catch {
      // A malformed block is skipped rather than failing the whole import.
    }
    if (out.length >= 20) break
  }
  return out
}

/** Find a schema.org Recipe object in JSON-LD blocks (top level, arrays, or @graph). */
function findRecipe(blocks: unknown[]): Record<string, unknown> | null {
  const queue = [...blocks]
  while (queue.length) {
    const node = queue.shift()
    if (Array.isArray(node)) queue.push(...node)
    else if (node && typeof node === 'object') {
      const obj = node as Record<string, unknown>
      const type = obj['@type']
      if (type === 'Recipe' || (Array.isArray(type) && type.includes('Recipe'))) return obj
      if (obj['@graph']) queue.push(obj['@graph'])
    }
  }
  return null
}

const BROWSER_HEADERS = {
  // A real browser UA clears the most basic bot checks; big sites still block.
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
  Accept: 'text/html,application/xhtml+xml',
  'Accept-Language': 'en-US,en;q=0.9',
}

/** How we introduce ourselves to the Internet Archive: honestly, as the small
 * app we are — never in a browser disguise. Its Sept 2026 access update says
 * it's getting better at telling abusive bots from real users, and the advice
 * to developers hitting its 429s is to identify your tool and not spoof
 * browser headers. (Our refused requests were exactly the disguised ones: the
 * page copies and photos sent BROWSER_HEADERS, while the plainly-sent lookups
 * weren't throttled.) */
const ARCHIVE_UA = 'CuratedKitchen/1.0 (personal recipe app; fetches one saved page per import)'

// The sign-in cookies (env.ARCHIVE_COOKIES), set at the top of every request —
// env is the same for a whole deployment. Sent ONLY to the Archive's own hosts
// (archive.org, web.archive.org): never to the image proxy, Jina, or a recipe
// site, since they'd let anyone act as the Worker's Archive account.
let archiveCookie = ''
const archiveHeaders = (accept = 'text/html,application/xhtml+xml'): Record<string, string> => ({
  'User-Agent': ARCHIVE_UA,
  Accept: accept,
  ...(archiveCookie ? { Cookie: archiveCookie } : {}),
})

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** How long a 429/503 asks us to wait (its Retry-After: seconds or a date), in
 * ms; null when it doesn't say. */
function retryAfterMs(res: Response): number | null {
  const raw = res.headers.get('Retry-After')
  if (!raw) return null
  const secs = Number(raw)
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000)
  const when = Date.parse(raw)
  return Number.isNaN(when) ? null : Math.max(0, when - Date.now())
}

/** What the last response said, for callers that need more than the text:
 * its status, and its final address after any redirects. */
type FetchInfo = { status?: number; url?: string }

/** Fetch a page as text; null if it failed. `retries` waits (ms) before each
 * retry of a 429 "too many requests" / 503 — the Internet Archive throttles the
 * shared addresses Workers fetch from, and a short wait sometimes clears it.
 * The response's own Retry-After wins: we log it (so `wrangler tail` shows how
 * long the Archive's lockouts really last), never retry sooner than it asks,
 * and give up at once if it asks for longer than we'd wait. */
async function fetchText(
  url: string,
  headers: Record<string, string>,
  label: string,
  retries: number[] = [],
  info: FetchInfo = {},
): Promise<string | null> {
  for (let attempt = 0; ; attempt++) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 20_000)
    let wait: number
    try {
      const res = await fetch(url, { headers, redirect: 'follow', signal: controller.signal })
      info.status = res.status
      info.url = res.url
      const throttled = res.status === 429 || res.status === 503
      const asks = throttled ? retryAfterMs(res) : null
      const hint = throttled ? `, retry-after ${asks === null ? 'not given' : `${Math.round(asks / 1000)}s`}` : ''
      console.log(`page ${label}: ${res.status}${attempt ? ` (retry ${attempt})` : ''}${hint}`)
      if (res.ok) return await res.text()
      if (res.status === 400) {
        // A rejected request — say why, so a broken query shows in the tail.
        const why = (await res.text().catch(() => '')).replace(/\s+/g, ' ').trim().slice(0, 160)
        console.log(`page ${label}: 400 says "${why || 'nothing'}"`)
        return null
      }
      await res.body?.cancel()
      if (!throttled || attempt >= retries.length) return null
      if (asks !== null && asks > 5_000) {
        console.log(`page ${label}: not retrying — it asked us to wait ${Math.round(asks / 1000)}s`)
        return null
      }
      wait = Math.max(retries[attempt], asks ?? 0)
    } catch (e) {
      info.status = undefined
      console.log(`page ${label}: failed ${String(e)}`)
      return null
    } finally {
      clearTimeout(timer)
    }
    await sleep(wait)
  }
}

type PageSource = 'direct' | 'reader' | 'archive'

/**
 * Get a recipe page's HTML, trying routes that get past the bot walls big sites
 * put up against server fetches like ours (a person's browser gets through; a
 * data-centre fetch doesn't):
 *   1. direct — our own fetch; fine for small sites.
 *   2. reader — Jina Reader (r.jina.ai), a free service (no key, ~20 req/min)
 *      that loads the page in a real browser on its servers.
 *   3. archive — the Internet Archive's latest saved copy; popular recipes are
 *      archived many times over, and archive.org serves them to anyone.
 * A page counts only if it carries schema.org Recipe data; failing that, the
 * first substantial page that isn't a bot challenge is returned for the AI to
 * read as text. Each step logs to `wrangler tail`.
 */
type RecipePage = { html: string; via: PageSource; stamp?: string }

/** The link as the Archive knows it: no #fragment, no tracking parameters
 * (a link shared from a phone often carries utm_…), which would miss its saves. */
function archiveKey(url: string): string {
  try {
    const u = new URL(url)
    u.hash = ''
    for (const key of [...u.searchParams.keys()]) {
      if (/^(utm_|fbclid$|gclid$|mc_|ref$|src$)/i.test(key)) u.searchParams.delete(key)
    }
    return u.toString()
  } catch {
    return url
  }
}

/** The Archive's latest good (200, HTML) saves of a page, newest first, from its
 * full capture index — slower than the "available" lookup but reliable. */
async function archiveCaptures(url: string, info: FetchInfo = {}): Promise<string[]> {
  // The last 10 saves, in the shape of the Archive's own documented example
  // (fastLatest + a negative limit). We pick the good ones ourselves: asking the
  // index to filter by status and type got a 400 from the live server.
  const index = await fetchText(
    `https://web.archive.org/cdx/search/cdx?url=${encodeURIComponent(url)}` +
      '&output=json&fl=timestamp,statuscode,mimetype&fastLatest=true&limit=-10',
    archiveHeaders('application/json'),
    'archive search',
    [],
    info,
  )
  try {
    const rows = JSON.parse(index ?? '[]') as unknown[]
    return rows
      .filter((row): row is unknown[] => Array.isArray(row) && row[0] !== 'timestamp') // skip the header row
      .filter((row) => String(row[1]) === '200' && String(row[2]).includes('html'))
      .map((row) => String(row[0]))
      .filter((ts) => /^\d{14}$/.test(ts))
      .sort()
      .reverse()
  } catch {
    return []
  }
}

/** What fetchRecipePage learned besides the page: `archiveBusy` = the Archive
 * refused us with "too many requests" (it has, or may have, a copy — we just
 * couldn't get it right now), so a failure is worth retrying in a few minutes. */
type PageLookup = { archiveBusy?: boolean }

async function fetchRecipePage(url: string, seen: PageLookup = {}): Promise<RecipePage | null> {
  let fallback: RecipePage | null = null
  let stamp: string | undefined
  const consider = (html: string | null, via: PageSource): boolean => {
    if (!html) return false
    if (findRecipe(extractJsonLd(html))) {
      console.log(`page ${via}: recipe data found`)
      fallback = { html, via, ...(via === 'archive' && stamp ? { stamp } : {}) }
      return true
    }
    const head = html.slice(0, 5000)
    const challenge = /access denied|just a moment|are you a robot|captcha|enable javascript and cookies/i.test(head)
    console.log(`page ${via}: no recipe data${challenge ? ' (bot challenge)' : ''}, ${html.length} chars`)
    if (!fallback && !challenge && html.length > 5000) fallback = { html, via, ...(via === 'archive' && stamp ? { stamp } : {}) }
    return false
  }

  let host = ''
  try {
    host = new URL(url).hostname
  } catch {
    return null
  }
  if (!isBlockedHost(host) && consider(await fetchText(url, BROWSER_HEADERS, 'direct'), 'direct')) return fallback
  const reader = await fetchText(`https://r.jina.ai/${url}`, { 'X-Return-Format': 'html', Accept: 'text/html' }, 'reader')
  if (consider(reader, 'reader')) return fallback
  // The Internet Archive. Its quick "available" lookup sometimes answers "no
  // copy" for pages it has saved many times (it did for a years-old Serious
  // Eats recipe), so when it comes up empty — or its copy isn't a recipe —
  // ask the full capture index (CDX) for the latest good saves too.
  const lookup = archiveKey(url)
  const busy = (info: FetchInfo) => info.status === 429 || info.status === 503
  const availInfo: FetchInfo = {}
  const avail = await fetchText(
    `https://archive.org/wayback/available?url=${encodeURIComponent(lookup)}`,
    archiveHeaders('application/json'),
    'archive lookup',
    [],
    availInfo,
  )
  let quick: string | undefined
  try {
    quick = (JSON.parse(avail ?? '{}') as { archived_snapshots?: { closest?: { available?: boolean; timestamp?: string } } })
      .archived_snapshots?.closest?.timestamp
  } catch {
    quick = undefined
  }
  // Saves we've read, so the index search below doesn't fetch one twice.
  const tried = new Set<string>()
  /** Read one saved copy: a recipe, some other page, missing, or refused
   * (still throttled after the retries — then more Archive requests won't
   * help). `ts` can be a moment rather than a save's own timestamp: the
   * Archive redirects to the save closest to it, and the final address says
   * which save that was. */
  const readCopy = async (ts: string, label = `archive ${ts}`): Promise<'recipe' | 'other' | 'missing' | 'refused'> => {
    // id_ = the page exactly as captured, without the Wayback toolbar/rewrites.
    const copy = `https://web.archive.org/web/${ts}id_/${lookup}`
    const copyInfo: FetchInfo = {}
    // No quick retries: in every real log, a 429 was still a 429 1.5 s and 3 s
    // later — retrying only added to the count the Archive holds against us.
    const archived = await fetchText(copy, archiveHeaders(), label, [], copyInfo)
    stamp = copyInfo.url?.match(/\/web\/(\d{14})id_\//)?.[1] ?? ts
    if (archived) {
      tried.add(stamp)
      if (stamp !== ts) console.log(`page ${label}: the save from ${stamp}`)
      return consider(archived, 'archive') ? 'recipe' : 'other'
    }
    if (!busy(copyInfo)) return 'missing'
    seen.archiveBusy = true
    if (archiveCookie) {
      console.log('page archive: refused even though signed in — the sign-in may have expired; run `npm run archive:login` again')
    }
    // Still throttled: have Jina Reader fetch the Archive's copy — its requests
    // come from its own addresses, not the shared ones the Archive limited.
    const viaReader = await fetchText(`https://r.jina.ai/${copy}`, { 'X-Return-Format': 'html', Accept: 'text/html' }, 'archive via reader')
    if (consider(viaReader, 'archive')) return 'recipe'
    return viaReader ? 'other' : 'refused'
  }
  if (quick) {
    const got = await readCopy(quick)
    if (got === 'recipe' || got === 'refused') return fallback
  } else {
    // The quick lookup says "no copy" at times for pages saved many times (a
    // years-old Serious Eats recipe, twice). Ask for the save closest to right
    // now instead — the latest — which is also the page itself, in one request.
    console.log('page archive lookup: nothing — asking for the latest save')
    const now = new Date().toISOString().replace(/\D/g, '').slice(0, 14)
    const got = await readCopy(now, 'archive latest')
    if (got === 'recipe' || got === 'refused') return fallback
  }
  // The copy we got wasn't a usable recipe page (or there was none): older
  // saves, from the Archive's full index.
  const searchInfo: FetchInfo = {}
  const saves = (await archiveCaptures(lookup, searchInfo)).filter((ts) => !tried.has(ts)).slice(0, 2)
  if (!tried.size && !saves.length) {
    // Both lookups throttled: we couldn't even check whether it has a copy.
    if (busy(availInfo) && busy(searchInfo)) seen.archiveBusy = true
    console.log(seen.archiveBusy ? 'page archive: too busy to check for a copy' : 'page archive: no saved copy')
  }
  for (const ts of saves) {
    const got = await readCopy(ts)
    if (got === 'recipe' || got === 'refused') break
  }
  return fallback
}

/** Visible text of a page, roughly: scripts/styles/chrome dropped, tags stripped. */
function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|noscript|svg|nav|header|footer|form|iframe)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<(br|\/p|\/div|\/li|\/h\d|\/tr|\/section|\/article)[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&#x27;|&rsquo;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n\n')
    .trim()
}

/** What the AI reads when it can't open a link itself: the page's recipe data
 * (precise amounts/steps) plus its visible text (headnote, notes, tips). */
function pageForAi(html: string, url: string): string {
  const recipe = findRecipe(extractJsonLd(html))
  const text = htmlToText(html).slice(0, 40_000)
  return [
    `Recipe page: ${url}`,
    recipe ? `Structured recipe data (schema.org JSON-LD):\n${JSON.stringify(recipe)}` : '',
    `Page text:\n${text}`,
  ]
    .filter(Boolean)
    .join('\n\n')
}

/* ---- Photos from a link import ---- */

/** Absolute http(s) image URLs from a schema.org `image` value (a URL, an
 * ImageObject, or a list of either), largest first when widths are given. */
function imageUrls(value: unknown, base: string): string[] {
  const items = Array.isArray(value) ? value : value ? [value] : []
  const found: { url: string; width: number }[] = []
  for (const item of items) {
    const raw =
      typeof item === 'string'
        ? item
        : item && typeof item === 'object'
          ? ((item as Record<string, unknown>).url ?? (item as Record<string, unknown>).contentUrl)
          : undefined
    if (typeof raw !== 'string') continue
    try {
      const u = new URL(raw, base)
      if (u.protocol !== 'https:' && u.protocol !== 'http:') continue
      const width = Number((item as Record<string, unknown>)?.width) || 0
      found.push({ url: u.toString(), width })
    } catch {
      /* not a URL */
    }
  }
  return found.sort((a, b) => b.width - a.width).map((f) => f.url)
}

/** The recipe's steps in order (sections flattened), as the AI sees them — a
 * bare string counts as a step too, so indexes line up with the AI's steps. */
function flattenSteps(instructions: unknown): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = []
  const walk = (node: unknown) => {
    if (Array.isArray(node)) node.forEach(walk)
    else if (typeof node === 'string') {
      if (node.trim()) out.push({ text: node })
    } else if (node && typeof node === 'object') {
      const obj = node as Record<string, unknown>
      const type = obj['@type']
      const isSection = type === 'HowToSection' || (Array.isArray(type) && type.includes('HowToSection'))
      if (isSection || (obj.itemListElement && !obj.text)) walk(obj.itemListElement)
      else out.push(obj)
    }
  }
  walk(instructions)
  return out
}

/** Each photo comes as a few candidate links (other sizes of the same photo),
 * best first; the app tries them in turn. `steps[i][j]` = step i's j-th photo. */
type LinkPhotos = { covers: string[]; steps: string[][][] }

/** A photo's name without its extension or a WordPress-style size suffix, so
 * every size of one photo compares equal ("salmon-1024x683.jpg" → "salmon"). */
function photoStem(link: string): string {
  try {
    const name = decodeURIComponent(new URL(link).pathname.split('/').pop() ?? '')
    return name.replace(/\.[a-z0-9]+$/i, '').replace(/-\d{2,4}x\d{2,4}$/, '').toLowerCase()
  } catch {
    return ''
  }
}

/** Every photo the page itself shows — its <img>/<source> src, srcset, and
 * lazy-load data-src/-srcset — grouped by photo (photoStem), each photo's sizes
 * widest first. One pass over the page, however many photos we look up. */
function pageImageIndex(html: string, base: string): Map<string, string[]> {
  const found = new Map<string, Map<string, number>>()
  for (const tag of html.match(/<(?:img|source)\b[^>]*>/gi) ?? []) {
    for (const attr of tag.matchAll(/\b(?:data-(?:lazy-)?)?(?:srcset|src)=["']([^"']+)["']/gi)) {
      for (const part of attr[1].split(/,\s+/)) {
        const [raw, descriptor] = part.trim().split(/\s+/)
        if (!raw || raw.startsWith('data:')) continue
        try {
          const u = new URL(raw.replace(/&amp;/g, '&'), base)
          if (u.protocol !== 'https:' && u.protocol !== 'http:') continue
          const stem = photoStem(u.toString())
          if (stem.length < 4) continue
          const width =
            Number(descriptor?.match(/^(\d+)w$/)?.[1]) || Number(u.pathname.match(/\/(\d{2,4})x\d*\//)?.[1]) || 0
          const sizes = found.get(stem) ?? new Map<string, number>()
          sizes.set(u.toString(), Math.max(sizes.get(u.toString()) ?? 0, width))
          found.set(stem, sizes)
        } catch {
          /* not a URL */
        }
      }
    }
  }
  return new Map([...found].map(([stem, sizes]) => [stem, [...sizes].sort((a, b) => b[1] - a[1]).map(([u]) => u)]))
}

/** Photo links the page publishes in its recipe data: the main photo and up to
 * 3 per step, capped at 10 photos in all. URLs only — the app downloads them
 * through /img, so this Worker never holds the bytes.
 *
 * Every photo comes as a few candidates, best first, which the app tries in
 * turn. Recipe data often names a size of a photo that the page never shows —
 * and the Internet Archive only saves the images a page shows — so each photo
 * also gets the sizes of it the page itself displays: first for a page read
 * from the Archive, after the listed size otherwise. (A Serious Eats import got
 * its cover this way but none of its step photos, which had only one link.) */
function findLinkPhotos(html: string, pageUrl: string, fromArchive: boolean): LinkPhotos {
  const recipe = findRecipe(extractJsonLd(html))
  const og = html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i)?.[1]
  const index = pageImageIndex(html, pageUrl)
  const candidates = (listed: string[], max: number): string[] => {
    const shown = listed.length ? (index.get(photoStem(listed[0])) ?? []) : []
    return [...new Set(fromArchive ? [...shown, ...listed] : [...listed, ...shown])].slice(0, max)
  }
  const listedCover = [...imageUrls(recipe?.image, pageUrl), ...(og ? imageUrls(og.replace(/&amp;/g, '&'), pageUrl) : [])]
  const covers = candidates(listedCover, 4)
  const coverStem = listedCover.length ? photoStem(listedCover[0]) : ''
  let budget = 9
  const steps = flattenSteps(recipe?.recipeInstructions).map((step) => {
    const take = imageUrls(step.image, pageUrl)
      .filter((u) => !covers.includes(u) && photoStem(u) !== coverStem) // the cover again
      .slice(0, Math.min(3, budget))
    budget -= take.length
    return take.map((u) => candidates([u], 3))
  })
  return { covers, steps }
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`

/** A photo link, short enough for a log line: host + the end of its path. */
function shortUrl(link: string): string {
  try {
    const { hostname, pathname } = new URL(link)
    return pathname.length > 48 ? `${hostname}/…${pathname.slice(-48)}` : hostname + pathname
  } catch {
    return link.slice(0, 80)
  }
}

/** wsrv.nl: a long-running free public image proxy (no key). It fetches from
 * its own servers, so neither a site's bot wall nor the Internet Archive's
 * throttling of Cloudflare's shared addresses sees our Worker. Capped at
 * 2048px — the app shrinks photos further anyway. */
const viaImageProxy = (link: string) => `https://wsrv.nl/?url=${encodeURIComponent(link)}&w=2048&h=2048&we`

/**
 * Stream one photo to the app (the browser can't fetch another site's image
 * itself). Only ever passes images through, so it can't be used as a general
 * proxy; the body is streamed, never buffered.
 */
async function handleImageProxy(body: { url?: string; stamp?: string }, origin: string): Promise<Response> {
  let target: URL
  try {
    target = new URL(String(body.url ?? ''))
  } catch {
    return json({ error: 'Bad image link.' }, 400, origin)
  }
  if ((target.protocol !== 'https:' && target.protocol !== 'http:') || isBlockedHost(target.hostname)) {
    return json({ error: 'Bad image link.' }, 400, origin)
  }
  const stamp = typeof body.stamp === 'string' && /^\d{4,14}$/.test(body.stamp) ? body.stamp : null
  const site = target.toString()
  const archived = stamp ? `https://web.archive.org/web/${stamp}im_/${site}` : null
  // The site first. Then, when the page itself came from the Archive, the
  // Archive's copy — asked for through the image proxy, which fetches from its
  // own servers. Our own requests to the Archive come from Cloudflare's shared
  // addresses, which it rations, and a photo-heavy import used to spend that
  // allowance before the next import's page (the part that matters most)
  // could get through. So we only ask the Archive directly if the proxy itself
  // is down (a timeout or 5xx) — never when it answered "not there" (4xx: the
  // Archive didn't save that photo, and would say the same to us). Last, the
  // proxy for the site's own image.
  const routes: Array<[label: string, url: string]> = [
    ['site', site],
    ...(archived
      ? ([
          ['proxy/archive', viaImageProxy(archived)],
          ['archive', archived],
        ] as Array<[string, string]>)
      : []),
    ['proxy', viaImageProxy(site)],
  ]
  // One line per photo in `wrangler tail`, e.g.
  //   img ok [site 403 → proxy/archive 200] www.example.com/…/salmon.jpg
  let proxyDown = false
  const trail: string[] = []
  for (const [label, url] of routes) {
    if (label === 'archive' && !proxyDown) continue
    // Give up on a route that hasn't started answering in 15 s (the timer only
    // guards the wait for headers; it's cleared before the body streams).
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 15_000)
    let res: Response
    try {
      res = await fetch(url, {
        // The Archive gets our honest name; the site (and the proxy) the browser's.
        headers: {
          ...(label === 'archive' ? archiveHeaders() : BROWSER_HEADERS),
          Accept: 'image/avif,image/webp,image/*,*/*;q=0.8',
        },
        redirect: 'follow',
        signal: controller.signal,
      })
    } catch {
      trail.push(`${label} ${controller.signal.aborted ? 'timed out' : 'failed'}`)
      if (label === 'proxy/archive') proxyDown = true
      continue
    } finally {
      clearTimeout(timer)
    }
    if (label === 'proxy/archive' && res.status >= 500) proxyDown = true
    const type = res.headers.get('Content-Type') ?? ''
    const size = Number(res.headers.get('Content-Length') ?? 0)
    if (res.ok && type.startsWith('image/') && size <= 12_000_000) {
      trail.push(`${label} ${res.status}`)
      console.log(`img ok [${trail.join(' → ')}] ${shortUrl(site)}`)
      return new Response(res.body, {
        status: 200,
        headers: { 'Content-Type': type, 'Cache-Control': 'no-store', ...corsHeaders(origin) },
      })
    }
    const asks = res.status === 429 || res.status === 503 ? retryAfterMs(res) : null
    trail.push(
      `${label} ${res.status}${res.ok ? ` ${type || 'no type'}` : ''}` +
        (asks !== null ? ` (retry-after ${Math.round(asks / 1000)}s)` : ''),
    )
    await res.body?.cancel() // free the connection; Workers cap open ones
  }
  console.log(`img failed [${trail.join(' → ')}] ${shortUrl(site)}`)
  return json({ error: 'Couldn’t get that photo.' }, 404, origin)
}

/**
 * A link: get the page ourselves (direct → Jina Reader → Internet Archive) so
 * we have its HTML — the recipe data AND its photos — and have Gemini read it
 * as text. Only when no route gets the page do we let Google read it (Gemini's
 * URL-context tool; no photos that way).
 */
// Diagnostics for the Archive's refusals: does a fresh copy of the Worker (a
// new deploy, or Cloudflare recycling an idle one) get through where a warm one
// was refused, and do refusals follow one outgoing network address? Each link
// import logs where it ran and what address the outside world sees.
const ISOLATE = Math.random().toString(36).slice(2, 6)
const ISOLATE_STARTED = Date.now()
let isolateRequests = 0

/** Our outgoing address as another site sees it (a free "what's my IP"
 * service); null if it doesn't answer within 3 s. It's Cloudflare's shared
 * address, not the cook's. Best effort — the Archive request may leave from a
 * different address in the same pool, which is part of what this tells us. */
async function egressAddress(): Promise<string | null> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 3_000)
  try {
    const res = await fetch('https://api.ipify.org?format=text', { signal: controller.signal })
    return res.ok ? (await res.text()).trim().slice(0, 45) : null
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

async function handleLink(url: string, env: Env, origin: string, colo = '?'): Promise<Response> {
  isolateRequests++
  const importNo = isolateRequests
  const upMin = Math.round((Date.now() - ISOLATE_STARTED) / 60_000)
  const address = egressAddress() // alongside the page fetches, not before them
  const seen: PageLookup = {}
  const page = await fetchRecipePage(url, seen)
  console.log(
    `link: ran in ${colo}, worker copy ${ISOLATE} (import #${importNo} since it started ${upMin} min ago), ` +
      `outgoing address ${(await address) ?? 'unknown'}, archive sign-in ${archiveCookie ? 'on' : 'off'}`,
  )
  if (!page) {
    const google = await handleGemini({ images: [], url }, env, origin)
    if (google.status !== 422 || !seen.archiveBusy) return google
    // Google couldn't open it either. Say why honestly: the Archive (the route
    // that usually gets blocked sites) was only too busy for us just now, so
    // trying again in a few minutes is worthwhile — not "this can't be done".
    const body = (await google.clone().json().catch(() => ({}))) as { detail?: string }
    if (!body.detail?.includes('URL_RETRIEVAL_STATUS') || body.detail.includes('PAYWALL')) return google
    const site = new URL(url).hostname.replace(/^www\./, '')
    console.log('link: archive busy — told the cook to try again shortly')
    return json(
      {
        error: `${site} blocks direct imports, and its saved copy at the Internet Archive is busy right now — try again in a few minutes, or paste the recipe text instead.`,
        detail: `archive busy; ${body.detail}`,
      },
      422,
      origin,
    )
  }
  console.log(`link: reading page via ${page.via} as text`)
  const res = await handleGemini({ images: [], text: pageForAi(page.html, url) }, env, origin)
  if (!res.ok) return res
  const out = (await res.json()) as { recipe?: { steps?: unknown[] } }
  const found = findLinkPhotos(page.html, url, page.via === 'archive')
  // Step photos follow the page's steps; attach them only if the AI kept the
  // same steps (it's told to keep the source's step boundaries).
  const aiSteps = Array.isArray(out.recipe?.steps) ? out.recipe!.steps!.length : 0
  const withPhotos = found.steps.filter((p) => p.length > 0).length
  // `steps` (each photo's first link) is what an app older than 0.42.2 reads;
  // `stepCandidates` carries every photo's other sizes to try.
  const steps: Record<number, string[]> = {}
  const stepCandidates: Record<number, string[][]> = {}
  if (aiSteps === found.steps.length) {
    found.steps.forEach((photos, i) => {
      if (!photos.length) return
      steps[i] = photos.map((c) => c[0])
      stepCandidates[i] = photos
    })
  }
  console.log(
    `link photos: cover=${found.covers.length ? `yes (${found.covers.length} to try)` : 'no'} stepPhotos=${withPhotos}/${found.steps.length} steps` +
      (withPhotos ? ` (${plural(found.steps.flat().length, 'photo')}, ${plural(found.steps.flat(2).length, 'size')} to try)` : '') +
      (withPhotos && aiSteps !== found.steps.length ? ` (AI made ${aiSteps} steps — step photos skipped)` : ''),
  )
  // `cover` (the first candidate) stays for an app that predates `covers`.
  const photos = {
    cover: found.covers[0] ?? null,
    covers: found.covers,
    steps,
    stepCandidates,
    ...(page.stamp ? { stamp: page.stamp } : {}),
  }
  return json({ ...out, photos }, 200, origin)
}

async function handleUrlImport(
  body: { url?: string },
  origin: string,
): Promise<Response> {
  const raw = typeof body.url === 'string' ? body.url.trim() : ''
  let target: URL
  try {
    target = new URL(raw)
  } catch {
    return json({ error: 'Enter a valid recipe link (starting with https://).' }, 400, origin)
  }
  if (target.protocol !== 'http:' && target.protocol !== 'https:') {
    return json({ error: 'Only http(s) links are supported.' }, 400, origin)
  }
  if (isBlockedHost(target.hostname)) {
    return json({ error: 'That link can’t be fetched.' }, 400, origin)
  }

  const page = await fetchRecipePage(target.toString())
  const jsonld = page ? extractJsonLd(page.html) : []
  if (!page || !findRecipe(jsonld)) {
    return json(
      { error: 'That site blocked the import. Try paste or a screenshot instead.' },
      502,
      origin,
    )
  }
  return json({ jsonld, url: target.toString() }, 200, origin)
}

/* ---- AI import: pasted text / a photo → structured recipe ---- */

type AiPhoto = { data: string; mediaType: string }
type AiInput = { text?: string; images: AiPhoto[]; url?: string }

/** The instruction that rides alongside any attached photos. Several photos are
 * treated as parts of ONE recipe (a long recipe needs several phone screenshots). */
function imagePrompt(input: AiInput): string {
  if (input.url) {
    return `Convert the recipe on this web page: ${input.url}\n\nUse only what that page says — if you can't read it, or it has no recipe, set not_a_recipe true rather than recalling a recipe from memory.`
  }
  if (input.text) return `Convert this recipe:\n\n${input.text}`
  if (input.images.length > 1) {
    return 'Convert the recipe in the attached images. They are multiple screenshots or pages of the SAME recipe, in order — combine them into one recipe, without duplicating any part shown in more than one image.'
  }
  return 'Convert the recipe in the attached image.'
}

/** Google Gemini (free tier). Uses structured JSON output matching our recipe
 * shape; the app's zod schema is still the real validator. Reads images too. */
async function handleGemini(input: AiInput, env: Env, origin: string): Promise<Response> {
  const parts: unknown[] = []
  for (const img of input.images) {
    parts.push({ inline_data: { mime_type: img.mediaType, data: img.data } })
  }
  parts.push({ text: imagePrompt(input) })

  // Lead with the lighter model: on the free tier the fuller flash models are
  // heavily contended (sustained 503s, and sometimes they just hang until a
  // Cloudflare 524 timeout), while -lite reliably has capacity and is plenty for
  // structured extraction. Fall back to the fuller flash if -lite is ever down.
  // Pin GEMINI_MODEL to force a single model (e.g. gemini-3.6-flash) with no
  // fallback. A retired id shows up as a 404 "no longer available."
  const primaryModel = env.GEMINI_MODEL || 'gemini-3.5-flash-lite'
  const models = env.GEMINI_MODEL ? [primaryModel] : [primaryModel, 'gemini-3.5-flash']
  console.log(
    `gemini start models=${models.join(',')} images=${input.images.length} textLen=${input.text?.length ?? 0}` +
      (input.url ? ` url=${input.url}` : ''),
  )
  // Structured JSON output. We deliberately do NOT send thinkingConfig — some
  // models (notably the -lite tier) reject it with 400 INVALID_ARGUMENT — and we
  // give generous output room so a long recipe's JSON isn't cut off. The app's
  // zod schema is the real validator, so if a model rejects our responseSchema
  // (400) we retry it once WITHOUT the schema (plain JSON, guided by the prompt).
  const buildBody = (useSchema: boolean): string => {
    const generationConfig: Record<string, unknown> = {
      temperature: 0,
      responseMimeType: 'application/json',
      maxOutputTokens: 16384,
    }
    if (useSchema) generationConfig.responseSchema = RECIPE_TOOL.input_schema
    return JSON.stringify({
      systemInstruction: { parts: [{ text: SYSTEM }] },
      contents: [{ role: 'user', parts }],
      // A link: let Gemini read the page itself (URL context). Google serves it
      // from its own search index first, so recipe sites that block our
      // Worker's fetch (Serious Eats et al.) still come through.
      ...(input.url ? { tools: [{ url_context: {} }] } : {}),
      generationConfig,
    })
  }
  // Abort a model that hangs so we move on instead of waiting for a ~100s
  // Cloudflare 524. A healthy call finishes in a few seconds; 30s is generous
  // (45s for a link, which may need a live page fetch first).
  const call = async (m: string, useSchema: boolean): Promise<Response | null> => {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), input.url ? 45_000 : 30_000)
    try {
      return await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-goog-api-key': env.GEMINI_API_KEY as string },
          body: buildBody(useSchema),
          signal: controller.signal,
        },
      )
    } catch (e) {
      console.log(`gemini fetch failed/timeout model=${m}: ${String(e)}`)
      return null
    } finally {
      clearTimeout(timer)
    }
  }

  // Try each model in turn. A 5xx (503 overloaded, 524 timeout, 500/502…) or a
  // missing fallback (404) → skip to the next model; a 400 → retry that model
  // once without the schema, then use/surface whatever we got.
  let res: Response | null = null
  let model = primaryModel
  for (const m of models) {
    let r = await call(m, true)
    if (!r) continue // network failure / timeout; try the next model
    if (r.status >= 500) {
      console.log(`gemini ${r.status} model=${m}; trying next`)
      continue
    }
    if (m !== primaryModel && r.status === 404) {
      console.log(`gemini fallback ${m} not available (404)`)
      continue
    }
    if (r.status === 400) {
      const detail = await r.text().catch(() => '')
      console.log(`gemini 400 model=${m}: ${detail.slice(0, 300)} — retrying without schema`)
      const r2 = await call(m, false)
      if (r2) r = r2
    }
    res = r
    model = m
    break
  }

  if (!res) {
    console.log('gemini all models unavailable')
    return json({ error: 'Gemini is busy right now — please try again in a moment.' }, 502, origin)
  }

  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    console.log(`gemini http ${res.status} model=${model}: ${detail.slice(0, 800)}`)
    const msg =
      res.status === 429
        ? 'The free AI limit was reached for now — try again shortly, or paste the recipe text.'
        : `AI service error (${res.status}).`
    return json({ error: msg, detail }, 502, origin)
  }

  const data = (await res.json().catch(() => ({}))) as {
    candidates?: Array<{
      finishReason?: string
      content?: { parts?: Array<{ text?: string }> }
      urlContextMetadata?: { urlMetadata?: Array<{ retrievedUrl?: string; urlRetrievalStatus?: string }> }
    }>
    promptFeedback?: { blockReason?: string }
  }
  // For a link, only trust the answer if Google actually read the page —
  // otherwise the model can "helpfully" produce a recipe from memory that isn't
  // what's on the page. (If the metadata is missing we can't tell, so we let it
  // through; the cook reviews it in the editor before saving.)
  if (input.url) {
    const statuses = (data.candidates?.[0]?.urlContextMetadata?.urlMetadata ?? []).map(
      (m) => m.urlRetrievalStatus ?? 'unknown',
    )
    console.log(`gemini url statuses=${statuses.join(',') || 'none'}`)
    if (statuses.length > 0 && !statuses.includes('URL_RETRIEVAL_STATUS_SUCCESS')) {
      // Google couldn't open it either (handleLink already tried our own routes).
      return json(
        {
          error: statuses.some((st) => st.includes('PAYWALL'))
            ? 'That page is behind a paywall — copy the recipe text or take a screenshot instead.'
            : 'Couldn’t open that page — copy the recipe text or take a screenshot instead.',
          detail: statuses.join(','),
        },
        422,
        origin,
      )
    }
  }
  const finishReason = data.candidates?.[0]?.finishReason
  const text = data.candidates?.[0]?.content?.parts?.map((p) => p.text ?? '').join('') ?? ''
  let recipe: {
    not_a_recipe?: boolean
    title?: string
    source?: { name?: string; author?: string }
    notes?: unknown[]
    equipment?: unknown[]
    tags?: unknown[]
    steps?: Array<{ brief?: unknown[] }>
  }
  try {
    recipe = JSON.parse(text)
  } catch {
    // finishReason (MAX_TOKENS, SAFETY, …) / blockReason names the real cause,
    // which is otherwise invisible when the client falls back to its parser.
    const why = finishReason || data.promptFeedback?.blockReason || 'no output'
    console.log(`gemini unreadable: finishReason=${why} textLen=${text.length}`)
    const msg =
      finishReason === 'MAX_TOKENS'
        ? 'That recipe was too long to read in one go — try fewer photos or just the recipe section.'
        : 'The AI didn’t return a readable recipe.'
    return json({ error: msg, detail: `finishReason=${why}` }, 502, origin)
  }
  if (recipe.not_a_recipe) {
    return json({ error: 'That didn’t look like a recipe.' }, 422, origin)
  }
  // Diagnostic: shows in `wrangler tail` which fields the model actually filled,
  // so we can tell a model gap from a client/UI one. It's your own recipe data.
  const len = (a?: unknown[]) => (Array.isArray(a) ? a.length : 0)
  console.log(
    'gemini import ok ' +
      JSON.stringify({
        model,
        finishReason,
        title: recipe.title ?? null,
        sourceName: recipe.source?.name ?? null,
        author: recipe.source?.author ?? null,
        notes: len(recipe.notes),
        equipment: len(recipe.equipment),
        tags: len(recipe.tags),
        briefSteps: Array.isArray(recipe.steps)
          ? recipe.steps.filter((s) => len(s.brief) > 0).length
          : 0,
      }),
  )
  return json({ recipe }, 200, origin)
}

/** Anthropic Claude (optional, paid). Forces the save_recipe tool for
 * structured output. Used only when no Gemini key is set. */
async function handleClaude(input: AiInput, env: Env, origin: string): Promise<Response> {
  const content: unknown[] = []
  for (const img of input.images) {
    content.push({
      type: 'image',
      source: { type: 'base64', media_type: img.mediaType, data: img.data },
    })
  }
  content.push({ type: 'text', text: imagePrompt(input) })

  let anthropic: Response
  try {
    anthropic = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': env.ANTHROPIC_API_KEY as string,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: env.ANTHROPIC_MODEL || 'claude-sonnet-5',
        max_tokens: 4096,
        system: SYSTEM,
        tools: [RECIPE_TOOL],
        tool_choice: { type: 'tool', name: 'save_recipe' },
        messages: [{ role: 'user', content }],
      }),
    })
  } catch {
    return json({ error: 'Could not reach the AI service.' }, 502, origin)
  }

  if (!anthropic.ok) {
    const detail = await anthropic.text().catch(() => '')
    return json({ error: `AI service error (${anthropic.status}).`, detail }, 502, origin)
  }

  const data = (await anthropic.json()) as { content?: Array<{ type: string; name?: string; input?: unknown }> }
  const toolUse = data.content?.find((b) => b.type === 'tool_use' && b.name === 'save_recipe')
  if (!toolUse?.input) {
    return json({ error: 'The AI didn’t return a recipe.' }, 502, origin)
  }
  const recipe = toolUse.input as { not_a_recipe?: boolean }
  if (recipe.not_a_recipe) {
    return json({ error: 'That didn’t look like a recipe.' }, 422, origin)
  }
  return json({ recipe }, 200, origin)
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const origin = env.ALLOWED_ORIGIN || 'https://cwang427.github.io'
    archiveCookie = env.ARCHIVE_COOKIES?.trim() ?? ''

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(origin) })
    }
    if (request.method !== 'POST') {
      return json({ error: 'Use POST.' }, 405, origin)
    }

    // Only signed-in household members may use the Worker.
    const auth = request.headers.get('Authorization') ?? ''
    const idToken = auth.startsWith('Bearer ') ? auth.slice(7) : ''
    if (!idToken) return json({ error: 'Missing sign-in token.' }, 401, origin)
    const uid = await verifyFirebaseToken(idToken, env.FIREBASE_PROJECT_ID)
    if (!uid) return json({ error: 'Not signed in.' }, 401, origin)

    let body: {
      text?: string
      image?: AiPhoto // legacy single-photo shape; kept for old app builds
      images?: AiPhoto[]
      url?: string
    }
    try {
      body = await request.json()
    } catch {
      return json({ error: 'Bad request body.' }, 400, origin)
    }

    const path = new URL(request.url).pathname.replace(/\/+$/, '')
    // Free route: fetch a URL and return its structured data. No API key needed.
    if (path.endsWith('/url')) return handleUrlImport(body, origin)
    // A link import's photos, streamed through (the app can't fetch them itself).
    if (path.endsWith('/img')) return handleImageProxy(body as { url?: string; stamp?: string }, origin)

    // AI route: turn pasted text / one-or-more photos into a structured recipe.
    // Accept the current `images` array and the legacy single `image`. Prefer
    // the free Gemini route; fall back to the (paid, optional) Claude route if
    // only that key is set.
    const images = body.images ?? (body.image ? [body.image] : [])
    // A link is read by Gemini itself (URL context), never fetched by this
    // Worker, so it needs no SSRF guard — just a well-formed http(s) URL.
    let url: string | undefined
    if (typeof body.url === 'string' && body.url.trim()) {
      try {
        const parsed = new URL(body.url.trim())
        if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') throw new Error('scheme')
        url = parsed.toString()
      } catch {
        return json({ error: 'Enter a valid recipe link (starting with https://).' }, 400, origin)
      }
    }
    if (!body.text && images.length === 0 && !url) {
      return json({ error: 'Paste a recipe or attach a photo.' }, 400, origin)
    }
    const input: AiInput = { text: body.text, images, url }
    if (env.GEMINI_API_KEY) {
      const colo = (request as Request & { cf?: { colo?: string } }).cf?.colo ?? '?'
      return url && !input.text && images.length === 0 ? handleLink(url, env, origin, colo) : handleGemini(input, env, origin)
    }
    if (url) return json({ error: 'Reading links needs the Gemini key on the server.' }, 501, origin)
    if (env.ANTHROPIC_API_KEY) return handleClaude(input, env, origin)
    return json({ error: 'AI import isn’t set up on the server.' }, 501, origin)
  },
}
