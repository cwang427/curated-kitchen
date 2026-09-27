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
        items: { type: 'string' },
        description: 'A few short lowercase browsing labels — cuisine, course, or main method (e.g. "italian", "weeknight", "one-pan") — only when clearly applicable.',
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
- In step text, wrap amounts that should scale with servings in {{ }} (e.g. "Add {{2 tbsp}} of the butter"). Leave times and temperatures as plain text. Put oven temps in the step's temperature field as well.
- For EVERY step, also fill "brief": a scannable cook-mode version of that same step, one action per line (an array of short lines). Reuse the same {{ }} tokens for scalable amounts. This is a condensed restatement of the step's own text — keep the full prose in "text"; never let an instruction appear only in "brief".
- Set "handsOff" true on a step that's a mostly-unattended wait the cook can step away from (simmer, bake, roast, braise, chill, rest, marinate, proof, reduce), and false on one that needs active attention (stir/whisk constantly, watch closely) or is a quick action. Omit if unclear.
- Fill "equipment" with the notable tools the recipe uses (skillet, food processor, pressure cooker, etc.) when it names or clearly requires them. Don't invent specifics the recipe doesn't imply.
- Fill "notes" with any tips, make-ahead, storage, or variation asides the source includes (e.g. a "Recipe Tip" or "Notes" section). Don't invent notes that aren't there.
- Fill the top-level metadata whenever the source shows it: title, subtitle, description (the headnote), source.name (the site or publication), source.author (the byline), source.url (only if a URL actually appears in the text), yield, and prep/cook/total times. Add a few "tags" (cuisine/course/method) when clearly applicable. Leave any field blank rather than guessing.
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

async function fetchText(url: string, headers: Record<string, string>, label: string): Promise<string | null> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 20_000)
  try {
    const res = await fetch(url, { headers, redirect: 'follow', signal: controller.signal })
    console.log(`page ${label}: ${res.status}`)
    return res.ok ? await res.text() : null
  } catch (e) {
    console.log(`page ${label}: failed ${String(e)}`)
    return null
  } finally {
    clearTimeout(timer)
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
async function fetchRecipePage(url: string): Promise<{ html: string; via: PageSource } | null> {
  let fallback: { html: string; via: PageSource } | null = null
  const consider = (html: string | null, via: PageSource): boolean => {
    if (!html) return false
    if (findRecipe(extractJsonLd(html))) {
      console.log(`page ${via}: recipe data found`)
      fallback = { html, via }
      return true
    }
    const head = html.slice(0, 5000)
    const challenge = /access denied|just a moment|are you a robot|captcha|enable javascript and cookies/i.test(head)
    console.log(`page ${via}: no recipe data${challenge ? ' (bot challenge)' : ''}, ${html.length} chars`)
    if (!fallback && !challenge && html.length > 5000) fallback = { html, via }
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
  const avail = await fetchText(
    `https://archive.org/wayback/available?url=${encodeURIComponent(url)}`,
    { Accept: 'application/json' },
    'archive lookup',
  )
  let stamp: string | undefined
  try {
    stamp = (JSON.parse(avail ?? '{}') as { archived_snapshots?: { closest?: { available?: boolean; timestamp?: string } } })
      .archived_snapshots?.closest?.timestamp
  } catch {
    stamp = undefined
  }
  if (stamp) {
    // id_ = the page exactly as captured, without the Wayback toolbar/rewrites.
    const archived = await fetchText(`https://web.archive.org/web/${stamp}id_/${url}`, BROWSER_HEADERS, `archive ${stamp}`)
    if (consider(archived, 'archive')) return fallback
  } else {
    console.log('page archive: no saved copy')
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
      // Google couldn't open it (big sites block its AI reader too). Get the
      // page another way and have Gemini read it as text instead.
      const page = await fetchRecipePage(input.url)
      if (page) {
        console.log(`gemini reading page via ${page.via} as text`)
        return handleGemini({ images: [], text: pageForAi(page.html, input.url) }, env, origin)
      }
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

    // Free route: fetch a URL and return its structured data. No API key needed.
    if (new URL(request.url).pathname.replace(/\/+$/, '').endsWith('/url')) {
      return handleUrlImport(body, origin)
    }

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
    if (env.GEMINI_API_KEY) return handleGemini(input, env, origin)
    if (url) return json({ error: 'Reading links needs the Gemini key on the server.' }, 501, origin)
    if (env.ANTHROPIC_API_KEY) return handleClaude(input, env, origin)
    return json({ error: 'AI import isn’t set up on the server.' }, 501, origin)
  },
}
