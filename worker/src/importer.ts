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
  // Optional: the Worker's Internet Archive sign-in (the Archive's Sept 2026
  // access update: signed-in users don't get its 429 "too many requests"). All
  // secrets, set together by `npm run archive:login` — never by hand, never in
  // wrangler.toml. ARCHIVE_SESSION = {"cookie", "expires"} (the saved sign-in);
  // ARCHIVE_EMAIL / ARCHIVE_PASSWORD = the app's Archive account, so the Worker
  // can sign itself in again when that expires or stops working.
  ARCHIVE_SESSION?: string
  ARCHIVE_EMAIL?: string
  ARCHIVE_PASSWORD?: string
  // 0.43's cookie-only sign-in (no expiry, no way to renew). Still honored.
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

const SYSTEM = `You convert recipes into Curated Kitchen's structured format. Be faithful to the source — never invent ingredients, amounts, times, or steps that aren't there, and never drop any. Keep the original wording of steps; only restructure amounts into {{ }} tokens.

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
- If the input clearly isn't a recipe, set not_a_recipe true and leave ingredients/steps empty.`

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

// Google's current signing keys (JWKS), kept for a few hours: they change
// rarely, and fetching them on every request made a hiccup at Google's end
// fail the whole request. A key we haven't seen fetches afresh.
let jwksCache: { keys: Array<Record<string, string>>; at: number } | null = null

/** The signing key named `kid`; null if Google doesn't list it. Throws if
 * Google's key server can't be reached (the caller answers "try again"). */
async function signingKey(kid: string): Promise<Record<string, string> | null> {
  const cached = jwksCache && Date.now() - jwksCache.at < 6 * 60 * 60_000 ? jwksCache.keys.find((k) => k.kid === kid) : undefined
  if (cached) return cached
  const res = await fetch('https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com', {
    signal: AbortSignal.timeout(5_000),
  })
  if (!res.ok) throw new Error(`signing keys: HTTP ${res.status}`)
  const { keys } = (await res.json()) as { keys: Array<Record<string, string>> }
  jwksCache = { keys, at: Date.now() }
  return keys.find((k) => k.kid === kid) ?? null
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

  const jwk = await signingKey(header.kid)
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

/** Is this JSON-LD node a schema.org Recipe? `@type` may be a string or a list
 * ("Recipe", ["Recipe", "NewsArticle"]), in any case, or a full schema.org URL. */
function isRecipeNode(obj: Record<string, unknown>): boolean {
  const types = Array.isArray(obj['@type']) ? obj['@type'] : [obj['@type']]
  return types.some((t) => typeof t === 'string' && /^(?:https?:\/\/schema\.org\/)?recipe$/i.test(t.trim()))
}

/** Find a schema.org Recipe object in JSON-LD blocks — at the top level, in
 * arrays, in @graph, or as a page's mainEntity (WebPage → Recipe). */
function findRecipe(blocks: unknown[]): Record<string, unknown> | null {
  const queue = [...blocks]
  for (let seen = 0; queue.length && seen < 500; seen++) {
    const node = queue.shift()
    if (Array.isArray(node)) queue.push(...node)
    else if (node && typeof node === 'object') {
      const obj = node as Record<string, unknown>
      if (isRecipeNode(obj)) return obj
      if (obj['@graph']) queue.push(obj['@graph'])
      if (obj.mainEntity) queue.push(obj.mainEntity)
    }
  }
  return null
}

/** How we introduce ourselves — to recipe sites, the reader service and the
 * Internet Archive alike: honestly, as the small app we are, with a link to it.
 * It used to claim to be Chrome for sites, which fooled nobody: a Worker's
 * connection looks nothing like a browser's, and a browser name on a
 * non-browser connection is exactly what bot filters score as spoofing. An
 * honest name won't get past a site that blocks automated fetches (nothing
 * from a Worker does — that's what the reader and the Archive are for), but it
 * doesn't make things worse, and it's what the Archive asks of tools. */
const APP_UA =
  'CuratedKitchen/1.0 (+https://cwang427.github.io/curated-kitchen/; personal recipe app, one page per member request)'
const SITE_HEADERS = {
  'User-Agent': APP_UA,
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
}
const ARCHIVE_UA = APP_UA

// ---- The Worker's Internet Archive sign-in ------------------------------------
// It keeps itself signed in, so nobody ever has to: the saved session is used
// until a day before it expires (the Archive's last a year); then the Worker
// signs in again with the stored email + password and carries on. It renews by
// the date only — not when the Archive refuses a request: a sign-in minutes old
// was refused just the same, so signing in again only cost another request.
// (The app waits and retries a busy Archive itself.) The session lives in this
// copy of the Worker's memory; a new copy starts from the saved one.
// Sent ONLY to the Archive's own hosts (archive.org, web.archive.org): never to
// the image proxy, Jina, or a recipe site — it would let them act as the account.

type ArchiveSession = { cookie: string; expires: number }
/** Set from env at the top of every request (env is the same for a deployment). */
let archiveSecrets: { saved?: string; legacy?: string; email?: string; password?: string } = {}
let archiveSession: ArchiveSession | null = null
let archiveSessionNote = ''
let signInBlockedUntil = 0
const DAY = 24 * 60 * 60_000

/** A cookie from a sign-in reply, without its "; path=/…" attributes. */
const cookieValue = (raw: unknown) => (typeof raw === 'string' ? raw.split(';')[0].trim() : '')

/** How long a cookie from a sign-in reply lasts (its Max-Age / Expires; else a
 * year, the Archive's usual). */
function cookieLifetime(raw: unknown): number {
  const text = typeof raw === 'string' ? raw : ''
  const maxAge = text.match(/max-age=(\d+)/i)?.[1]
  if (maxAge) return Number(maxAge) * 1000
  const at = Date.parse(text.match(/expires=([^;]+)/i)?.[1] ?? '')
  return Number.isFinite(at) ? at - Date.now() : 365 * DAY
}

/** The saved sign-in (ARCHIVE_SESSION), or 0.43's cookie-only one. */
function savedArchiveSession(): ArchiveSession | null {
  try {
    const saved = JSON.parse(archiveSecrets.saved ?? '') as { cookie?: string; expires?: string }
    const expires = Date.parse(saved.expires ?? '')
    if (saved.cookie && Number.isFinite(expires)) return { cookie: saved.cookie, expires }
  } catch {
    /* not set, or not JSON */
  }
  const legacy = archiveSecrets.legacy?.trim()
  return legacy ? { cookie: legacy, expires: Infinity } : null // expiry unknown: trust it (0.44+'s setup saves one)
}

/** Sign in with the stored email + password. After a failure, wait 10 minutes
 * before trying again rather than hammering the Archive's sign-in; imports carry
 * on unsigned meanwhile. */
async function archiveSignIn(why: string): Promise<ArchiveSession | null> {
  const { email, password } = archiveSecrets
  if (!email || !password || Date.now() < signInBlockedUntil) return null
  const failed = (reason: string) => {
    signInBlockedUntil = Date.now() + 10 * 60_000
    console.log(
      `archive sign-in: failed (${reason}) — importing without it; will try again in 10 min. ` +
        "If the app's Archive password changed, run `npm run archive:login` again.",
    )
    return null
  }
  try {
    const res = await fetch('https://archive.org/services/xauthn/?op=login', {
      method: 'POST',
      headers: { 'User-Agent': ARCHIVE_UA, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ email, password }),
    })
    const reply = (await res.json().catch(() => null)) as {
      success?: boolean
      values?: { reason?: string; cookies?: Record<string, string> }
    } | null
    const cookies = reply?.values?.cookies ?? {}
    const user = cookieValue(cookies['logged-in-user'])
    const sig = cookieValue(cookies['logged-in-sig'])
    if (!reply?.success || !user || !sig) return failed(reply?.values?.reason ?? `HTTP ${res.status}`)
    const lifetime = Math.min(cookieLifetime(cookies['logged-in-user']), cookieLifetime(cookies['logged-in-sig']))
    console.log(`archive sign-in: signed in automatically (${why})`)
    return { cookie: `logged-in-user=${user}; logged-in-sig=${sig}`, expires: Date.now() + lifetime }
  } catch (e) {
    return failed(String(e))
  }
}

/** The sign-in to use now: this copy's, else the saved one — renewed a day
 * before it expires. null = not set up, or signing in isn't working. */
async function currentArchiveSession(): Promise<ArchiveSession | null> {
  const soon = Date.now() + DAY
  if (archiveSession && archiveSession.expires > soon) return archiveSession
  const saved = archiveSession ? null : savedArchiveSession()
  if (saved && saved.expires > soon) {
    archiveSession = saved
    archiveSessionNote =
      saved.expires === Infinity ? 'saved' : `saved, until ${new Date(saved.expires).toISOString().slice(0, 10)}`
    return saved
  }
  const current = archiveSession ?? saved
  const fresh = await archiveSignIn(current ? 'the saved sign-in was about to expire' : 'no saved sign-in')
  if (fresh) {
    archiveSession = fresh
    archiveSessionNote = 'signed in automatically'
    return fresh
  }
  // Couldn't renew: one that hasn't quite expired still beats none.
  return current && current.expires > Date.now() ? current : null
}

/** For the tail's diagnostics line. */
function archiveSignInStatus(): string {
  if (archiveSession) return `on (${archiveSessionNote})`
  const { saved, legacy, email } = archiveSecrets
  if (!saved && !legacy && !email) return 'off (not set up)'
  return Date.now() < signInBlockedUntil ? 'off (signing in failed — see above)' : 'ready (not needed this time)'
}

/** Headers for a request to the Archive: our honest name, plus the sign-in. */
async function archiveHeaders(accept = 'text/html,application/xhtml+xml'): Promise<Record<string, string>> {
  const session = await currentArchiveSession()
  return { 'User-Agent': ARCHIVE_UA, Accept: accept, ...(session ? { Cookie: session.cookie } : {}) }
}

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
 * its status, its final address after any redirects, whether it was a saved
 * copy of the site's own error (`memento`: the Archive replaying a 429 the site
 * once sent it, not the Archive refusing us), how long a refusal asked us to
 * wait, and whether we gave up waiting (`timedOut`) or called it off
 * (`cancelled`: another route won first). */
type FetchInfo = {
  status?: number
  url?: string
  memento?: boolean
  retryAfterMs?: number | null
  timedOut?: boolean
  cancelled?: boolean
}

/** Tests run the time budgets faster (resetForTests); 1 in the Worker. */
let timeScale = 1

/** Fetch a page as text; null if it failed. Never retried here: in every real
 * log a refusal was still a refusal seconds later, and retrying only adds to
 * the count held against the address. Each route has its own time budget
 * (`timeoutMs`), so a slow host can't hold the import; `signal` lets a caller
 * call it off (the reader racing the direct fetch). */
async function fetchText(
  url: string,
  headers: Record<string, string>,
  label: string,
  info: FetchInfo = {},
  { timeoutMs = 20_000, signal }: { timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<string | null> {
  const controller = new AbortController()
  const timer = setTimeout(() => {
    info.timedOut = true
    controller.abort()
  }, timeoutMs * timeScale)
  const cancel = () => {
    info.cancelled = true
    controller.abort()
  }
  signal?.addEventListener('abort', cancel)
  try {
    const res = await fetch(url, { headers, redirect: 'follow', signal: controller.signal })
    info.status = res.status
    info.url = res.url
    info.memento = res.headers.has('memento-datetime')
    const throttled = res.status === 429 || res.status === 503
    info.retryAfterMs = throttled ? retryAfterMs(res) : null
    const hint = throttled
      ? `, retry-after ${info.retryAfterMs === null ? 'not given' : `${Math.round(info.retryAfterMs / 1000)}s`}` +
        (info.memento ? " (a saved copy of the site's own refusal)" : '')
      : ''
    console.log(`page ${label}: ${res.status}${hint}`)
    if (res.ok) return await res.text()
    if (res.status === 400) {
      // A rejected request — say why, so a broken query shows in the tail.
      const why = (await res.text().catch(() => '')).replace(/\s+/g, ' ').trim().slice(0, 160)
      console.log(`page ${label}: 400 says "${why || 'nothing'}"`)
      return null
    }
    await res.body?.cancel()
    return null
  } catch (e) {
    info.status = undefined
    console.log(
      `page ${label}: ${info.cancelled ? 'called off (another route got there first)' : info.timedOut ? `no answer in ${timeoutMs / 1000}s` : `failed ${String(e)}`}`,
    )
    return null
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', cancel)
  }
}

// ---- The Archive's page copies: a breaker ----------------------------------
// The Archive rations requests by the address they come from, and a Worker's
// requests leave from addresses Cloudflare shares among all its customers — so
// others can use up the allowance before our first request. What the Archive
// penalises is carrying on while it refuses, so after a refusal we stop asking
// it for page copies for a while: 90 s, doubling on each refusal in a row to a
// 10-minute cap, with a little jitter so copies of the Worker don't all come
// back at once. Its lookups (archive.org/wayback/available) are a different
// host that has never refused us, so they carry on regardless. Real logs showed
// refused copies working again within minutes, hence the short cap. A copy of
// the Worker keeps this in memory; another copy learns on its own first refusal.
let replayBlockedUntil = 0
let replayStrikes = 0
let replayRefusedAt = 0

/** How long until the Archive's page copies are worth asking for again (0 = now). */
function replayWaitMs(): number {
  return Math.max(0, replayBlockedUntil - Date.now())
}

/** Record how a page-copy request went. A 429/503 that isn't a saved copy of
 * the site's own refusal, or no answer in time, opens the breaker; any other
 * answer closes it. Returns whether we were refused. */
function noteReplay(info: FetchInfo): boolean {
  const refused = info.timedOut === true || ((info.status === 429 || info.status === 503) && !info.memento)
  if (!refused) {
    if (info.status && replayRefusedAt) {
      // Sets the cap from data rather than argument: how long refusals last.
      console.log(`archive breaker: answered again ${Math.round((Date.now() - replayRefusedAt) / 1000)}s after the first refusal`)
    }
    if (info.status) {
      replayStrikes = 0
      replayRefusedAt = 0
    }
    return false
  }
  const wait = Math.max(Math.min(10 * 60_000, 90_000 * 2 ** replayStrikes), info.retryAfterMs ?? 0)
  replayStrikes++
  if (!replayRefusedAt) replayRefusedAt = Date.now()
  replayBlockedUntil = Date.now() + wait + Math.random() * 10_000
  console.log(`archive breaker: not asking for page copies for ${Math.round(replayWaitMs() / 1000)}s (refusal #${replayStrikes} in a row)`)
  return true
}

type PageSource = 'direct' | 'reader' | 'archive'

/**
 * Get a recipe page's HTML, trying routes that get past the bot walls big sites
 * put up against server fetches like ours (a person's browser gets through; a
 * data-centre fetch doesn't):
 *   1. direct — our own fetch; fine for small sites. If it hasn't answered in
 *      3 s, the reader starts alongside it and the first recipe wins.
 *   2. reader — Jina Reader (r.jina.ai), a free service (no key, ~20 req/min)
 *      that loads the page in a real browser on its servers.
 *   3. archive — the Internet Archive's latest saved copy; popular recipes are
 *      archived many times over, and archive.org serves them to anyone.
 * A page with clear recipe signs (recipe data, recipe markup, an Ingredients
 * heading) ends the search; otherwise the clearest page any route brought is
 * kept for the AI to read. Every route has its own time budget, so the whole
 * search takes well under a minute. Each step logs to `wrangler tail`.
 */
type RecipePage = { html: string; via: PageSource; stamp?: string; signal: number }

// How clearly a page is a recipe (recipeSignal). Also the words other
// languages use, since friends may import non-English recipes.
const INGREDIENTS_WORD = /\b(?:ingredients?|ingr[ée]dients?|ingredientes|zutaten|ingredi[ëe]nten)\b/i
const INGREDIENTS_HEADING = /<h[1-6][^>]*>\s*(?:<[^>]+>\s*)*(?:ingredients?|ingr[ée]dients|ingredientes|zutaten)\b/i
const RECIPE_MARKUP =
  /itemtype=["'][^"']*schema\.org\/Recipe["']|itemprop=["']recipeIngredient["']|class=["'][^"']*\b(?:wprm-recipe|tasty-recipes|mv-create-card|easyrecipe|recipe-card)/i
// Bot challenges and block pages, from the vendors recipe sites use. Only
// consulted for a page without recipe markup — a real recipe page may well
// load a challenge vendor's script ("captcha" on a comment form) too.
const CHALLENGE =
  /access denied|just a moment\.\.\.|are you a robot|(?<!re)captcha|enable javascript and cookies|press (?:&amp;|&) hold|px-captcha|verify you are (?:a )?human|checking your browser|attention required|request unsuccessful|incapsula|datadome/i

/** 3 = schema.org Recipe data, 2 = recipe markup (a recipe plugin, microdata)
 * or an Ingredients heading, 1 = mentions ingredients, 0 = no sign of a recipe,
 * -1 = a bot challenge, block page or near-empty page. */
function recipeSignal(html: string): number {
  if (findRecipe(extractJsonLd(html))) return 3
  if (RECIPE_MARKUP.test(html) || INGREDIENTS_HEADING.test(html)) return 2
  if (html.length < 5_000 || CHALLENGE.test(html.slice(0, 20_000))) return -1
  return INGREDIENTS_WORD.test(html) ? 1 : 0
}

const SIGNAL_NOTE: Record<number, string> = {
  3: 'recipe data found',
  2: 'recipe markup found (no recipe data)',
  1: 'no recipe data, mentions ingredients',
  0: 'no recipe data',
  [-1]: 'no recipe data (bot challenge or near-empty)',
}

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
 * full capture index — slower than the "available" lookup but reliable. The
 * index lives on the same host as the page copies, so it waits out the breaker too. */
async function archiveCaptures(url: string, info: FetchInfo = {}): Promise<string[]> {
  if (replayWaitMs() > 0) return []
  // The last 10 saves, in the shape of the Archive's own documented example
  // (fastLatest + a negative limit). We pick the good ones ourselves: asking the
  // index to filter by status and type got a 400 from the live server.
  const index = await fetchText(
    `https://web.archive.org/cdx/search/cdx?url=${encodeURIComponent(url)}` +
      '&output=json&fl=timestamp,statuscode,mimetype&fastLatest=true&limit=-10',
    await archiveHeaders('application/json'),
    'archive search',
    info,
    { timeoutMs: 8_000 },
  )
  noteReplay(info)
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

/** What fetchRecipePage learned besides the page. `archiveBusy`: the Archive
 * refused us (or we're waiting out a refusal) — it has, or may have, a copy we
 * couldn't get just now, so trying again in a few minutes is worthwhile.
 * `archiveCopy`: a link to a saved copy we know exists, which Google's reader
 * can open from its own servers. `readerRefused`: the reader service won't
 * fetch this site at all (451). `archive`: how the Archive went, for the log. */
type PageLookup = {
  archiveBusy?: boolean
  archiveCopy?: string
  readerRefused?: boolean
  archive?: 'recipe' | 'other' | 'missing' | 'refused' | 'skipped' | 'no copy'
}

const READER_HEADERS = { 'X-Return-Format': 'html', 'X-Timeout': '10', Accept: 'text/html', 'User-Agent': APP_UA }

async function fetchRecipePage(url: string, seen: PageLookup = {}): Promise<RecipePage | null> {
  let best: RecipePage | null = null
  let stamp: string | undefined
  /** Keep the page if it's the clearest recipe yet; true = clear enough to stop. */
  const consider = (html: string | null, via: PageSource): boolean => {
    if (!html) return false
    const signal = recipeSignal(html)
    console.log(`page ${via}: ${SIGNAL_NOTE[signal]}, ${html.length} chars`)
    if (signal >= 0 && (!best || signal > best.signal)) {
      best = { html, via, signal, ...(via === 'archive' && stamp ? { stamp } : {}) }
    }
    return signal >= 2
  }

  let host = ''
  try {
    host = new URL(url).hostname
  } catch {
    return null
  }
  // The direct fetch, and the reader if the direct fetch is slow (3 s) or
  // fails: a slow site then costs the reader's time rather than both added up,
  // and the first to bring a recipe wins — the other is called off.
  const race = new AbortController()
  const readerInfo: FetchInfo = {}
  const readPage = (signal?: AbortSignal) =>
    fetchText(`https://r.jina.ai/${url}`, READER_HEADERS, 'reader', readerInfo, { timeoutMs: 12_000, signal })
  const direct = isBlockedHost(host)
    ? Promise.resolve(null)
    : fetchText(url, SITE_HEADERS, 'direct', {}, { timeoutMs: 8_000, signal: race.signal })
  const early = await Promise.race([direct.then((html) => ({ html })), sleep(3_000 * timeScale).then(() => null)])
  let found: boolean
  if (early) {
    found = consider(early.html, 'direct') || consider(await readPage(), 'reader')
  } else {
    const reader = readPage(race.signal)
    found = await new Promise<boolean>((resolve) => {
      let left = 2
      const settle = (html: string | null, via: PageSource) => {
        if (consider(html, via)) resolve(true)
        else if (--left === 0) resolve(false)
      }
      void direct.then((html) => settle(html, 'direct'))
      void reader.then((html) => settle(html, 'reader'))
    })
    race.abort()
  }
  seen.readerRefused = readerInfo.status === 451
  if (found) return best

  // The Internet Archive. Its quick "available" lookup sometimes answers "no
  // copy" for pages it has saved many times (it did for a years-old Serious
  // Eats recipe), so when it comes up empty — or its copy isn't a recipe —
  // ask for the latest save, then the full capture index (CDX).
  const lookup = archiveKey(url)
  const busy = (info: FetchInfo) => info.status === 429 || info.status === 503
  const availInfo: FetchInfo = {}
  const avail = await fetchText(
    `https://archive.org/wayback/available?url=${encodeURIComponent(lookup)}`,
    await archiveHeaders('application/json'),
    'archive lookup',
    availInfo,
    { timeoutMs: 6_000 },
  )
  let quick: string | undefined
  try {
    quick = (JSON.parse(avail ?? '{}') as { archived_snapshots?: { closest?: { available?: boolean; timestamp?: string } } })
      .archived_snapshots?.closest?.timestamp
  } catch {
    quick = undefined
  }
  if (quick && !/^\d{14}$/.test(quick)) quick = undefined
  // Saves we've read, so the index search below doesn't fetch one twice.
  const tried = new Set<string>()
  /** Read one saved copy: a recipe, some other page, missing, or refused (then
   * more Archive requests won't help — the breaker is open). `ts` can be a
   * moment rather than a save's own timestamp: the Archive redirects to the
   * save closest to it, and the final address says which save that was. */
  const readCopy = async (ts: string, label = `archive ${ts}`): Promise<'recipe' | 'other' | 'missing' | 'refused'> => {
    // id_ = the page exactly as captured, without the Wayback toolbar/rewrites.
    const copy = `https://web.archive.org/web/${ts}id_/${lookup}`
    seen.archiveCopy ??= copy
    if (replayWaitMs() > 0) {
      console.log(`page ${label}: skipped — the Archive refused us moments ago; asking again in ${Math.round(replayWaitMs() / 1000)}s`)
      seen.archiveBusy = true
      seen.archive = 'skipped'
      return 'refused'
    }
    const copyInfo: FetchInfo = {}
    const archived = await fetchText(copy, await archiveHeaders(), label, copyInfo, { timeoutMs: 12_000 })
    const refused = noteReplay(copyInfo)
    stamp = copyInfo.url?.match(/\/web\/(\d{14})id_\//)?.[1] ?? ts
    if (archived) {
      tried.add(stamp)
      if (stamp !== ts) console.log(`page ${label}: the save from ${stamp}`)
      seen.archive = consider(archived, 'archive') ? 'recipe' : 'other'
      return seen.archive
    }
    if (!refused) {
      seen.archive = 'missing'
      return 'missing'
    }
    seen.archiveBusy = true
    seen.archive = 'refused'
    if (archiveSession) console.log(`page archive: busy even though signed in (${archiveSessionNote})`)
    // The reader fetching the Archive's copy from its own addresses — unless it
    // already refused this site: it refuses any link naming a site that blocks
    // it, Archive links included (Serious Eats, 5 of 5 in real logs).
    if (seen.readerRefused) return 'refused'
    const viaReader = await fetchText(`https://r.jina.ai/${copy}`, READER_HEADERS, 'archive via reader', {}, { timeoutMs: 12_000 })
    if (consider(viaReader, 'archive')) {
      seen.archive = 'recipe'
      return 'recipe'
    }
    return viaReader ? 'other' : 'refused'
  }
  if (quick) {
    const got = await readCopy(quick)
    if (got === 'recipe' || got === 'refused') return best
  } else {
    // The quick lookup says "no copy" at times for pages saved many times (a
    // years-old Serious Eats recipe, twice). Ask for the save closest to right
    // now instead — the latest — which is also the page itself, in one request.
    console.log('page archive lookup: nothing — asking for the latest save')
    const now = new Date().toISOString().replace(/\D/g, '').slice(0, 14)
    const got = await readCopy(now, 'archive latest')
    if (got === 'recipe' || got === 'refused') return best
  }
  // The copy we got wasn't a usable recipe page (or there was none): older
  // saves, from the Archive's full index.
  const searchInfo: FetchInfo = {}
  const saves = (await archiveCaptures(lookup, searchInfo)).filter((ts) => !tried.has(ts)).slice(0, 2)
  if (!tried.size && !saves.length) {
    // Both lookups throttled: we couldn't even check whether it has a copy.
    if (busy(availInfo) && busy(searchInfo)) seen.archiveBusy = true
    if (seen.archive === 'missing' || !seen.archive) seen.archive = 'no copy'
    console.log(seen.archiveBusy ? 'page archive: too busy to check for a copy' : 'page archive: no saved copy')
  }
  for (const ts of saves) {
    const got = await readCopy(ts)
    if (got === 'recipe' || got === 'refused') break
  }
  return best
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
        // Our honest name everywhere; only the Archive gets the sign-in.
        headers: {
          ...(label === 'archive' ? await archiveHeaders() : SITE_HEADERS),
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
    const declared = res.headers.get('Content-Length')
    const size = Number(declared ?? 0)
    if (res.ok && res.body && type.startsWith('image/') && size <= 12_000_000) {
      trail.push(`${label} ${res.status}`)
      console.log(`img ok [${trail.join(' → ')}] ${shortUrl(site)}`)
      // No declared size: count the bytes as they pass and stop at the same cap.
      let passed = 0
      const capped = declared
        ? res.body
        : res.body.pipeThrough(
            new TransformStream<Uint8Array, Uint8Array>({
              transform(chunk, out) {
                passed += chunk.byteLength
                if (passed > 12_000_000) out.error(new Error('image too large'))
                else out.enqueue(chunk)
              },
            }),
          )
      return new Response(capped, {
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

// Diagnostics for the Archive's refusals: where the import ran, which copy of
// the Worker ran it, and the IPv4 address the outside world sees. The Archive
// has no IPv6 address, so our requests reach it over IPv4; the IPv6 address this
// used to log was one the Archive never sees. Looked up once per Worker copy
// (the answer is only a rough guide: Cloudflare may pick a different address
// per destination).
const ISOLATE = Math.random().toString(36).slice(2, 6)
// Set on this copy's first import: at start-up a Worker's clock reads 1970 (it
// only moves during a request), which logged "started 29842834 min ago".
let isolateStarted = 0
let isolateRequests = 0
let egressV4: string | null = null

async function outgoingAddress(): Promise<string> {
  if (egressV4) return egressV4
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 3_000)
  try {
    const res = await fetch('https://api4.ipify.org?format=text', { signal: controller.signal })
    if (res.ok) egressV4 = (await res.text()).trim().slice(0, 45)
  } catch {
    /* best effort */
  } finally {
    clearTimeout(timer)
  }
  return egressV4 ?? 'unknown'
}

/** Sites that refuse every route we have (subscriber-only), so a link answers
 * at once with what to do instead of a half-minute search that can't succeed. */
const REFUSING_SITES: Array<[host: RegExp, message: string]> = [
  [
    /(^|\.)cooking\.nytimes\.com$/,
    'NYT Cooking recipes are for subscribers only, so the app can’t open the link — copy the recipe text (or take a screenshot) and add it that way.',
  ],
]

/** A recipe the AI read without the page itself, so without its photos. */
type LinkVia = PageSource | 'google' | 'google-archive'

/**
 * A link: get the page ourselves (direct → Jina Reader → Internet Archive) so
 * we have its HTML — the recipe data AND its photos — and have Gemini read it
 * as text. Only when no route gets the page does Google read it (Gemini's
 * URL-context tool), which brings the recipe but not its photos — the answer
 * says so (`photosUnavailable`), and the app lets the cook choose.
 */
async function handleLink(url: string, env: Env, origin: string, colo = '?'): Promise<Response> {
  const started = Date.now()
  isolateRequests++
  if (!isolateStarted) isolateStarted = started
  const importNo = isolateRequests
  const upMin = Math.round((started - isolateStarted) / 60_000)
  const host = new URL(url).hostname
  // One line per import, as fields Workers Logs can filter: which sites friends
  // use, which route worked, how long it took, and whether photos came along.
  const outcome = (fields: Record<string, unknown>) =>
    console.log({ event: 'import', host, ms: Date.now() - started, archive: seen.archive ?? 'not needed', ...fields })
  const seen: PageLookup = {}

  const refusal = REFUSING_SITES.find(([pattern]) => pattern.test(host))
  if (refusal) {
    outcome({ via: 'none', status: 422, why: 'refusing site' })
    return json({ error: refusal[1], code: 'site_refuses' }, 422, origin)
  }

  const address = outgoingAddress() // alongside the page fetches, not before them
  const page = await fetchRecipePage(url, seen)
  console.log(
    `link: ran in ${colo}, worker copy ${ISOLATE} (import #${importNo} since it started ${upMin} min ago), ` +
      `outgoing IPv4 ${await address}, archive sign-in ${archiveSignInStatus()}`,
  )
  if (!page) return readWithGoogle(url, seen, env, origin, outcome)

  console.log(`link: reading page via ${page.via} as text`)
  const res = await handleGemini({ images: [], text: pageForAi(page.html, url) }, env, origin)
  const found = findLinkPhotos(page.html, url, page.via === 'archive')
  const stampField = page.stamp ? { stamp: page.stamp } : {}
  if (!res.ok) {
    const body = (await res.clone().json().catch(() => ({}))) as { code?: string }
    // The page we got said it wasn't a recipe, and it showed no recipe signs —
    // likely a soft block or cookie wall, not the real page: let Google try.
    if (res.status === 422 && body.code === 'not_a_recipe' && page.signal <= 1) {
      console.log('link: the page we got wasn’t the recipe — asking Google instead')
      return readWithGoogle(url, seen, env, origin, outcome)
    }
    // The AI itself failed (busy, over its free limit) but we have the page:
    // hand back its recipe data and cover, so the app can offer the simpler
    // import right away instead of fetching the page all over again.
    const recipe = page.signal === 3 ? findRecipe(extractJsonLd(page.html)) : null
    if (res.status !== 422 && recipe) {
      const trimmed = { ...recipe }
      for (const key of ['review', 'comment', 'aggregateRating', 'video', 'publisher', 'isPartOf', 'mainEntityOfPage']) delete trimmed[key]
      outcome({ via: page.via, status: res.status, ai: 'failed, recipe data handed back' })
      return json(
        { ...body, code: 'ai_busy', jsonld: [trimmed], photos: { cover: found.covers[0] ?? null, covers: found.covers, steps: {}, ...stampField } },
        res.status,
        origin,
      )
    }
    outcome({ via: page.via, status: res.status, ai: 'failed' })
    return res
  }
  const out = (await res.json()) as { recipe?: { steps?: unknown[] } }
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
  outcome({ via: page.via, status: 200, cover: found.covers.length > 0, stepPhotos: Object.keys(steps).length })
  // `cover` (the first candidate) stays for an app that predates `covers`.
  const photos = { cover: found.covers[0] ?? null, covers: found.covers, steps, stepCandidates, ...stampField }
  return json({ ...out, via: page.via, photos }, 200, origin)
}

/**
 * No route got the page itself: Google's reader reads it instead, from Google's
 * own servers — the recipe, but not its photos (without the page we can't find
 * them). A site the reader service refuses outright (Serious Eats) refuses
 * Google too, so when the Archive has a copy we just couldn't get, Google reads
 * that copy instead; otherwise the page itself first, then the copy. The
 * answer carries `photosUnavailable`, and — when the Archive was only busy —
 * `retryAfterMs`, when trying again could bring the photos too.
 */
async function readWithGoogle(
  url: string,
  seen: PageLookup,
  env: Env,
  origin: string,
  outcome: (fields: Record<string, unknown>) => void,
): Promise<Response> {
  const copy = seen.archiveBusy ? seen.archiveCopy : undefined
  const targets: Array<{ url: string; archivedFrom?: string; via: LinkVia }> = []
  if (!(copy && seen.readerRefused)) targets.push({ url, via: 'google' })
  if (copy) targets.push({ url: copy, archivedFrom: url, via: 'google-archive' })
  // Trying again is worth it only when the Archive was busy (it has, or may
  // have, a copy with photos we couldn't get just now). At least a minute:
  // the breaker's own wait when it's open, else the Archive's usual spell.
  const retryAfterMs = seen.archiveBusy ? Math.max(replayWaitMs(), 60_000) : undefined
  let last: Response | null = null
  for (const target of targets) {
    console.log(target.via === 'google-archive' ? 'link: asking Google to read the Archive’s copy' : 'link: asking Google to read the page')
    const res = await handleGemini({ images: [], url: target.url, archivedFrom: target.archivedFrom }, env, origin)
    if (res.ok) {
      const out = (await res.json()) as Record<string, unknown>
      outcome({ via: target.via, status: 200, cover: false, stepPhotos: 0, photos: 'unavailable' })
      return json({ ...out, via: target.via, photosUnavailable: true, ...(retryAfterMs ? { retryAfterMs } : {}) }, 200, origin)
    }
    last = res
    if (res.status !== 422) break // the AI itself failed; the next target would too
  }
  const body = (await last!.clone().json().catch(() => ({}))) as { detail?: string }
  if (last!.status === 422 && seen.archiveBusy && body.detail?.includes('URL_RETRIEVAL_STATUS') && !body.detail.includes('PAYWALL')) {
    // Nothing could be read. Say why honestly: the Archive (the route that
    // usually gets blocked sites) was only too busy for us just now, so trying
    // again in a few minutes is worthwhile — not "this can't be done".
    const site = new URL(url).hostname.replace(/^www\./, '')
    outcome({ via: 'none', status: 422, why: 'archive busy' })
    return json(
      {
        error: `${site} blocks direct imports, and its saved copy at the Internet Archive is busy right now.`,
        code: 'archive_busy',
        retryAfterMs,
        detail: `archive busy; ${body.detail}`,
      },
      422,
      origin,
    )
  }
  outcome({ via: 'none', status: last!.status })
  return last!
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
/** `archivedFrom`: `url` is the Internet Archive's copy of this original link. */
type AiInput = { text?: string; images: AiPhoto[]; url?: string; archivedFrom?: string }

/** The instruction that rides alongside any attached photos. Several photos are
 * treated as parts of ONE recipe (a long recipe needs several phone screenshots). */
function imagePrompt(input: AiInput): string {
  if (input.url) {
    const archived = input.archivedFrom
      ? `\n\nThis is the Internet Archive's saved copy of ${input.archivedFrom} — the recipe's source is that original site, not the Internet Archive or the Wayback Machine.`
      : ''
    return `Convert the recipe on this web page: ${input.url}${archived}\n\nUse only what that page says — if you can't read it, or it has no recipe, set not_a_recipe true rather than recalling a recipe from memory.`
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
  // (25s for a link — Google's reader is the last of several routes by then,
  // and the whole import should stay well under a minute).
  const call = async (m: string, useSchema: boolean): Promise<Response | null> => {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), input.url ? 25_000 : 30_000)
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

  // Try each model in turn. A 5xx (503 overloaded, 524 timeout, 500/502…), a
  // 429 (free-tier quotas are per model, so the next may have room) or a
  // missing fallback (404) → skip to the next model; a 400 → retry that model
  // once without the schema, then use/surface whatever we got.
  let res: Response | null = null
  let model = primaryModel
  for (const [i, m] of models.entries()) {
    let r = await call(m, true)
    if (!r) continue // network failure / timeout; try the next model
    if (r.status >= 500) {
      console.log(`gemini ${r.status} model=${m}; trying next`)
      continue
    }
    if (r.status === 429 && i < models.length - 1) {
      console.log(`gemini 429 model=${m} (its free limit); trying next`)
      res = new Response(await r.text().catch(() => ''), { status: 429 }) // reported if every model is out
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
    return json({ error: 'That didn’t look like a recipe.', code: 'not_a_recipe' }, 422, origin)
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

export const worker = {
  async fetch(request: Request, env: Env): Promise<Response> {
    const origin = env.ALLOWED_ORIGIN || 'https://cwang427.github.io'
    archiveSecrets = {
      saved: env.ARCHIVE_SESSION,
      legacy: env.ARCHIVE_COOKIES,
      email: env.ARCHIVE_EMAIL?.trim(),
      password: env.ARCHIVE_PASSWORD,
    }

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
    let uid: string | null
    try {
      uid = await verifyFirebaseToken(idToken, env.FIREBASE_PROJECT_ID)
    } catch (e) {
      console.log(`sign-in check failed: ${String(e)}`)
      return json({ error: 'Couldn’t check your sign-in just now — please try again.' }, 503, origin)
    }
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

// For scripts/test-worker.ts (index.ts, the Worker's entry, exports only `worker`).
export { handleLink, handleImageProxy, fetchRecipePage, recipeSignal, findRecipe, replayWaitMs }
export type { PageLookup }

/** Forget everything this copy of the Worker has learned — for tests only. */
export function resetForTests(secrets: typeof archiveSecrets = {}, scale = 1): void {
  timeScale = scale
  archiveSecrets = secrets
  archiveSession = null
  archiveSessionNote = ''
  signInBlockedUntil = 0
  replayBlockedUntil = 0
  replayStrikes = 0
  replayRefusedAt = 0
  egressV4 = null
  jwksCache = null
}
