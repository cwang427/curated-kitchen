/**
 * Tests for the recipe-import Worker's link route (worker/src/importer.ts),
 * against a fake internet: every outside request goes to a stub, so these
 * check what the Worker ASKS for (which routes, how many Archive requests, what
 * it calls itself) as well as what it answers. Time budgets run 100× faster.
 *
 *   npm run test:worker
 */
import {
  importJob,
  handleLink,
  handleImageProxy,
  recipeSignal,
  findRecipe,
  replayWaitMs,
  resetForTests,
  worker,
} from '../worker/src/importer'

// The Worker's own log lines are collected (to check what it says), so the
// test's output goes through the real console.
const realLog = console.log
const RealDate = Date
let passed = 0
let failed = 0
function check(label: string, cond: boolean, detail?: unknown): void {
  if (cond) {
    realLog(`  ✓ ${label}`)
    passed++
  } else {
    console.error(`  ✗ ${label}${detail === undefined ? '' : `: ${JSON.stringify(detail).slice(0, 600)}`}`)
    failed++
  }
}
/** Move the clock forward by `ms` (the breaker's windows are minutes long). */
function clockAhead(ms: number): void {
  ;(globalThis as { Date: DateConstructor }).Date = class extends RealDate {
    static now() {
      return RealDate.now() + ms
    }
  } as DateConstructor
}

const URL_ = 'https://www.seriouseats.com/the-best-roast-potatoes-ever-recipe'
const BLOG = 'https://smallblog.example/lentil-soup/'
const env = { FIREBASE_PROJECT_ID: 'test', GEMINI_API_KEY: 'k' }
const filler = '<p>Crispy, fluffy, golden.</p>'.repeat(300)
const ld = (extra: Record<string, unknown> = {}) =>
  `<script type="application/ld+json">${JSON.stringify({
    '@type': 'Recipe',
    name: 'Potatoes',
    image: 'https://img.example/potatoes.jpg',
    recipeIngredient: ['potatoes'],
    recipeInstructions: [{ '@type': 'HowToStep', text: 'Roast.', image: 'https://img.example/step1.jpg' }],
    ...extra,
  })}</script>`
const PAGES = {
  recipeData: `<html><head>${ld()}</head><body>${filler}</body></html>`,
  markup: `<html><body><div class="wprm-recipe-container"><h3>Ingredients</h3><ul><li>potatoes</li></ul></div>${filler}</body></html>`,
  plain: `<html><body><h1>About us</h1>${filler}</body></html>`,
  challenge: `<html><body><div id="px-captcha">Press &amp; Hold to confirm you are a human</div>${'<div></div>'.repeat(2000)}</body></html>`,
}
const AI_RECIPE = '{"title":"Potatoes","ingredients":[{"item":"potatoes","category":"produce"}],"steps":[{"text":"Roast."}]}'

type Call = { url: string; headers: Headers }
type World = {
  direct?: (signal?: AbortSignal) => Response | Promise<Response>
  reader?: (url: string) => Response | Promise<Response>
  lookup?: () => Response
  replay?: (url: string) => Response | Promise<Response>
  /** Google's reader: which links it can open. */
  googleReads?: (url: string) => boolean
  gemini?: (model: string, body: { tools?: unknown }) => Response
  /** Firecrawl's /v2/scrape: its answer for a request body. */
  firecrawl?: (body: { url: string; formats: string[]; proxy?: string }) => Response | Promise<Response>
}

let calls: Call[] = []
const logs: string[] = []

/** Answer every outside request from the scenario; anything unexpected is a 404. */
function install(w: World): void {
  calls = []
  logs.length = 0
  console.log = (...args: unknown[]) => logs.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '))
  globalThis.fetch = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input instanceof Request ? input.url : input)
    calls.push({ url, headers: new Headers(init.headers) })
    const hang = () =>
      new Promise<Response>((_, reject) => init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))))
    if (url.startsWith('https://checkip.amazonaws.com')) return new Response('104.28.1.1\n')
    if (url === 'https://api.firecrawl.dev/v2/team/credit-usage') {
      return new Response(JSON.stringify({ success: true, data: { remainingCredits: 987, billingPeriodEnd: '2026-10-27T00:00:00Z' } }))
    }
    if (url === 'https://api.firecrawl.dev/v2/scrape') {
      const body = JSON.parse(String(init.body))
      return w.firecrawl ? w.firecrawl(body) : new Response('{"success":false}', { status: 500 })
    }
    if (url.includes('generativelanguage.googleapis.com')) {
      const model = url.match(/models\/([^:]+):/)?.[1] ?? ''
      const body = JSON.parse(String(init.body)) as { tools?: unknown; contents: Array<{ parts: Array<{ text?: string }> }> }
      if (!url.includes(':streamGenerateContent?alt=sse')) return new Response('wrong endpoint', { status: 404 })
      // Like a real response, the stream breaks off when the request is called off.
      const tied = (res: Response): Response => {
        const signal = init.signal
        if (!res.body || !signal) return res
        const reader = res.body.getReader()
        const aborted = new Promise<never>((_, reject) =>
          signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))),
        )
        aborted.catch(() => {})
        const body = new ReadableStream<Uint8Array>({
          async pull(c) {
            try {
              const { value, done } = await Promise.race([reader.read(), aborted])
              if (done) c.close()
              else c.enqueue(value)
            } catch (e) {
              c.error(e)
            }
          },
        })
        return new Response(body, { status: res.status, headers: res.headers })
      }
      if (w.gemini) {
        const r = w.gemini(model, body)
        if ((r as unknown) === 'hang') return hang()
        // A plain JSON answer from a scenario is sent the way Gemini streams:
        // as server-sent events.
        if (r && r.ok && r.headers.get('Content-Type') !== 'text/event-stream') return sse([JSON.parse(await r.text())])
        if (r) return tied(r)
      }
      const prompt = body.contents[0].parts.map((p) => p.text ?? '').join('')
      const link = body.tools ? prompt.match(/web page: (\S+)/)?.[1] ?? '' : ''
      const ok = !body.tools || (w.googleReads?.(link) ?? false)
      // The answer in two pieces, the metadata in the last — as Gemini sends it.
      const half = Math.floor(AI_RECIPE.length / 2)
      return sse([
        { candidates: [{ content: { parts: [{ text: AI_RECIPE.slice(0, half) }] } }] },
        {
          candidates: [
            {
              finishReason: 'STOP',
              content: { parts: [{ text: AI_RECIPE.slice(half) }] },
              ...(body.tools
                ? { urlContextMetadata: { urlMetadata: [{ urlRetrievalStatus: ok ? 'URL_RETRIEVAL_STATUS_SUCCESS' : 'URL_RETRIEVAL_STATUS_ERROR' }] } }
                : {}),
            },
          ],
        },
      ])
    }
    if (url.startsWith('https://r.jina.ai/')) return w.reader ? w.reader(url) : new Response('refused', { status: 451 })
    if (url.startsWith('https://archive.org/wayback/available')) {
      return w.lookup?.() ?? new Response(JSON.stringify({ archived_snapshots: { closest: { available: true, timestamp: '20260810220319' } } }))
    }
    if (url.startsWith('https://web.archive.org/cdx/')) return new Response('[]')
    if (url.startsWith('https://web.archive.org/web/')) {
      const r = w.replay ? w.replay(url) : new Response(PAGES.recipeData)
      return (r as unknown) === 'hang' ? hang() : r
    }
    if (url === URL_ || url === BLOG) {
      if (!w.direct) return new Response('Forbidden', { status: 403 })
      return w.direct(init.signal ?? undefined)
    }
    return new Response('not found', { status: 404 })
  }) as typeof fetch
}

/** A streamed Gemini answer: each piece as a server-sent event, `gapMs` apart
 * (a `stallAfter` piece is followed by silence instead). */
function sse(pieces: unknown[], gapMs = 0, stallAfter = -1): Response {
  const enc = new TextEncoder()
  let i = 0
  const body = new ReadableStream<Uint8Array>({
    async pull(c) {
      if (i > 0 && gapMs) await new Promise((r) => setTimeout(r, gapMs))
      if (i > stallAfter && stallAfter >= 0) return new Promise<void>(() => {}) // silence
      if (i >= pieces.length) return c.close()
      c.enqueue(enc.encode(`data: ${JSON.stringify(pieces[i++])}\r\n\r\n`))
    },
  })
  return new Response(body, { headers: { 'Content-Type': 'text/event-stream' } })
}
const slices = (text: string, n: number) =>
  Array.from({ length: n }, (_, k) => ({
    candidates: [{ content: { parts: [{ text: text.slice((k * text.length) / n, ((k + 1) * text.length) / n) }] }, ...(k === n - 1 ? { finishReason: 'STOP' } : {}) }],
  }))

const archiveCalls = () => calls.filter((c) => /(^https:\/\/web\.archive\.org\/)/.test(c.url))
const replayCalls = () => calls.filter((c) => c.url.startsWith('https://web.archive.org/web/'))
const readerCalls = () => calls.filter((c) => c.url.startsWith('https://r.jina.ai/'))
const googleCalls = () => calls.filter((c) => c.url.includes('generativelanguage'))
const importLog = () => logs.find((l) => l.includes('"event":"import"')) ?? ''
async function link(url = URL_) {
  const res = await handleLink(url, env as never, 'https://app.example', 'TEST')
  return { status: res.status, body: (await res.json()) as Record<string, unknown> }
}
const refused = () => new Response('slow down', { status: 429 })
function section(name: string) {
  console.log = realLog
  realLog(name)
}

// ---------------------------------------------------------------------------
section('recipe signals')
check('JSON-LD recipe → 3', recipeSignal(PAGES.recipeData) === 3)
check('recipe plugin markup → 2', recipeSignal(PAGES.markup) === 2)
check('microdata → 2', recipeSignal(`<div itemscope itemtype="https://schema.org/Recipe">${filler}</div>`) === 2)
check('Ingredients heading → 2', recipeSignal(`<h2><span>Ingredients</span></h2>${filler}`) === 2)
check('mentions ingredients → 1', recipeSignal(`<p>the ingredients are simple</p>${filler}`) === 1)
check('no signs → 0', recipeSignal(PAGES.plain) === 0)
check('"Press & Hold" challenge → -1', recipeSignal(PAGES.challenge) === -1)
check('reCAPTCHA on a real recipe page is not a challenge', recipeSignal(`<script src="https://www.google.com/recaptcha/api.js"></script>${ld()}${filler}`) === 3)
check('reCAPTCHA alone does not make a page a challenge', recipeSignal(`<script src="/recaptcha/api.js"></script><p>ingredients</p>${filler}`) === 1)
check('near-empty page → -1', recipeSignal('<html>hi</html>') === -1)
check('WebPage.mainEntity → Recipe found', findRecipe([{ '@type': 'WebPage', mainEntity: { '@type': 'Recipe', name: 'x' } }])?.name === 'x')
check('@type in lowercase / as a list', findRecipe([{ '@type': ['recipe', 'NewsArticle'], name: 'y' }])?.name === 'y')
check('@type as a schema.org URL', findRecipe([{ '@type': 'http://schema.org/Recipe', name: 'z' }])?.name === 'z')

// ---------------------------------------------------------------------------
section('a site that lets us in')
resetForTests({}, 0.01)
install({ direct: () => new Response(PAGES.recipeData) })
let r = await link(BLOG)
check('imports from the direct fetch', r.status === 200 && r.body.via === 'direct', r.body)
check('no reader, no Archive requests', readerCalls().length === 0 && archiveCalls().length === 0 && !calls.some((c) => c.url.includes('archive.org')))
check('brings photo links (cover + step)', (r.body.photos as { covers: string[] }).covers[0] === 'https://img.example/potatoes.jpg')
check('the outcome line names host, route and photos', /"host":"smallblog.example".*"via":"direct".*"cover":true/.test(importLog()), importLog())

resetForTests({}, 0.01)
install({ direct: () => new Response(PAGES.markup) })
r = await link(BLOG)
check('recipe-plugin page with no recipe data: used as is, no Archive', r.status === 200 && r.body.via === 'direct' && !calls.some((c) => c.url.includes('archive.org')), calls.map((c) => c.url))

resetForTests({}, 0.01)
install({ direct: () => new Response(PAGES.challenge), reader: () => new Response(PAGES.recipeData) })
r = await link(BLOG)
check('a 200 bot challenge escalates to the reader', r.status === 200 && r.body.via === 'reader', r.body)

resetForTests({}, 0.01)
install({ direct: () => new Response(PAGES.plain), reader: () => new Response(PAGES.markup), replay: () => new Response(PAGES.plain) })
r = await link(BLOG)
check('a recipe page from the reader beats a signless direct page', r.status === 200 && r.body.via === 'reader', r.body)

// The direct fetch is slow: the reader starts after 3 s (30 ms here) and wins.
resetForTests({}, 0.01)
install({
  direct: (signal) =>
    new Promise((res, reject) => {
      const t = setTimeout(() => res(new Response(PAGES.recipeData)), 70)
      signal?.addEventListener('abort', () => {
        clearTimeout(t)
        reject(new DOMException('aborted', 'AbortError'))
      })
    }),
  reader: () => new Response(PAGES.recipeData),
})
r = await link(BLOG)
check('slow site: the reader starts alongside and wins', r.status === 200 && r.body.via === 'reader', r.body)
check('the slow direct fetch is called off', logs.some((l) => l.includes('page direct: called off')), logs)

// ---------------------------------------------------------------------------
section('honest name, sign-in only to the Archive')
resetForTests({ legacy: 'logged-in-user=a; logged-in-sig=b' }, 0.01)
install({})
await link()
check('no request claims to be Chrome', calls.every((c) => !/Chrome|Mozilla/.test(c.headers.get('User-Agent') ?? '')), calls.map((c) => c.headers.get('User-Agent')))
check('site, reader and Archive requests say who we are', calls.filter((c) => /seriouseats|jina|archive/.test(c.url)).every((c) => (c.headers.get('User-Agent') ?? '').startsWith('CuratedKitchen/1.0')))
check('the Archive sign-in goes only to archive hosts', calls.filter((c) => c.headers.get('Cookie')).every((c) => /^https:\/\/(web\.)?archive\.org\//.test(c.url)))

// ---------------------------------------------------------------------------
section('Serious Eats while the Archive refuses us')
resetForTests({}, 0.01)
install({ replay: refused, googleReads: (u) => u.startsWith('https://web.archive.org/') })
r = await link()
check('one refused page copy, no index search, no reader-of-archive', replayCalls().length === 1 && archiveCalls().length === 1 && readerCalls().length === 1, calls.map((c) => c.url))
check('the breaker opens for about 90 s', replayWaitMs() > 85_000 && replayWaitMs() <= 100_000, replayWaitMs())
check('Google reads the Archive copy (not the blocked site)', googleCalls().length === 1 && r.status === 200 && r.body.via === 'google-archive', r.body)
check('…and says photos are unavailable, try again after the breaker', r.body.photosUnavailable === true && Number(r.body.retryAfterMs) >= 60_000, r.body)

// Straight away, a second import: no page-copy request at all.
install({ replay: refused, googleReads: (u) => u.startsWith('https://web.archive.org/') })
r = await link()
check('next import within the window: zero page-copy requests', replayCalls().length === 0 && archiveCalls().length === 0, calls.map((c) => c.url))
check('…the lookup still runs (a different host) and Google still gets the copy', calls.some((c) => c.url.startsWith('https://archive.org/wayback/available')) && r.body.via === 'google-archive')
check('…and the tail says why', logs.some((l) => l.includes('skipped — the Archive refused us moments ago')))

// Google can't open the copy either: the honest "busy" answer, with when to try again.
resetForTests({}, 0.01)
install({ replay: refused, googleReads: () => false })
r = await link()
check('nothing readable → 422 archive_busy', r.status === 422 && r.body.code === 'archive_busy', r.body)
check('…with retryAfterMs from the breaker', Number(r.body.retryAfterMs) >= 85_000, r.body)
check('…and one line of text, no "try again in a few minutes" (the app says that)', !String(r.body.error).includes('try again'), r.body.error)

// A second refusal in a row doubles the wait; a later answer closes it.
resetForTests({}, 0.01)
install({ replay: refused })
await link()
const first = replayWaitMs()
// Pretend the window passed.
clockAhead(first + 1_000)
install({ replay: refused })
await link()
check('second refusal in a row: about 3 min', replayWaitMs() > 175_000 && replayWaitMs() <= 190_000, replayWaitMs())
clockAhead(first + 200_000)
install({})
r = await link()
check('once the Archive answers, the import works and the breaker closes', r.status === 200 && r.body.via === 'archive' && replayWaitMs() === 0, r.body)
check('…and logs how long the refusals lasted', logs.some((l) => /answered again \d+s after the first refusal/.test(l)), logs)
;(globalThis as { Date: DateConstructor }).Date = RealDate

// A saved copy of the SITE's own 429 is not the Archive refusing us.
resetForTests({}, 0.01)
install({ replay: () => new Response('site said slow down', { status: 429, headers: { 'memento-datetime': 'Mon, 10 Aug 2026 22:03:19 GMT' } }) })
await link()
check('a replayed 429 (memento-datetime) leaves the breaker closed', replayWaitMs() === 0)

// A page copy that never answers counts as a refusal and ends the Archive's turn.
resetForTests({}, 0.01)
install({ replay: () => 'hang' as unknown as Response })
r = await link()
check('a copy that times out opens the breaker', replayWaitMs() > 85_000, replayWaitMs())
check('…and no index search or more copies after it', archiveCalls().length === 1, calls.map((c) => c.url))

// ---------------------------------------------------------------------------
section('the Archive sign-in keeps itself fresh')
{
  const SAVED = 'logged-in-user=k%40example.com; logged-in-sig=OLD'
  const FRESH = 'logged-in-user=k%40example.com; logged-in-sig=NEW'
  const days = (n: number) => new RealDate(RealDate.now() + n * 86_400_000).toISOString()
  const creds = { email: 'k@example.com', password: 'pw' }
  let signIns = 0
  const withSignIn = (reply: 'ok' | 'account_bad_password') => {
    const base = globalThis.fetch
    globalThis.fetch = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
      if (String(input).startsWith('https://archive.org/services/xauthn/')) {
        signIns++
        return new Response(
          JSON.stringify(
            reply === 'ok'
              ? { success: true, values: { cookies: { 'logged-in-user': 'k%40example.com; Max-Age=31536000; path=/', 'logged-in-sig': 'NEW; Max-Age=31536000; path=/' } } }
              : { success: false, values: { reason: reply } },
          ),
        )
      }
      return base(input, init)
    }) as typeof fetch
  }
  const replayCookie = () => replayCalls()[0]?.headers.get('Cookie') ?? null

  resetForTests({ saved: JSON.stringify({ cookie: SAVED, expires: days(200) }), ...creds }, 0.01)
  install({})
  withSignIn('ok')
  signIns = 0
  await link()
  check('a saved sign-in with months left is used as is', replayCookie() === SAVED && signIns === 0)

  resetForTests({ saved: JSON.stringify({ cookie: SAVED, expires: days(0.5) }), ...creds }, 0.01)
  install({})
  withSignIn('ok')
  signIns = 0
  await link()
  check('one about to expire is renewed first', replayCookie() === FRESH && signIns === 1)

  resetForTests({ saved: JSON.stringify({ cookie: SAVED, expires: days(200) }), ...creds }, 0.01)
  install({ replay: refused, googleReads: () => true })
  withSignIn('ok')
  signIns = 0
  await link()
  check('a refusal does NOT trigger signing in again (it never helped)', signIns === 0 && replayCalls().length === 1)

  resetForTests({ ...creds }, 0.01)
  install({})
  withSignIn('account_bad_password')
  signIns = 0
  r = await link()
  check('a failed sign-in: the import carries on unsigned', r.status === 200 && replayCookie() === null && signIns === 1)
  install({})
  withSignIn('account_bad_password')
  await link()
  check('…and it waits 10 min before trying to sign in again', signIns === 1)

  resetForTests({}, 0.01)
  install({})
  await link()
  check('not set up: no cookie, no sign-in', replayCookie() === null && logs.some((l) => l.includes('archive sign-in off (not set up)')))
}

// ---------------------------------------------------------------------------
section('Firecrawl (the unlocker)')
{
  const KEY = 'fc-test-key'
  const unlocked = (html: string, statusCode = 200) =>
    new Response(JSON.stringify({ success: true, data: { rawHtml: html, metadata: { statusCode } } }))
  const scrapes = () => calls.filter((c) => c.url === 'https://api.firecrawl.dev/v2/scrape')

  // Not set up: never asked.
  resetForTests({}, 0.01)
  install({ replay: refused, googleReads: () => true, firecrawl: () => unlocked(PAGES.recipeData) })
  await link()
  check('no key → Firecrawl never asked', scrapes().length === 0)

  // A site that lets us in: Firecrawl isn't needed, so no credit is spent.
  resetForTests({}, 0.01, KEY)
  install({ direct: () => new Response(PAGES.recipeData), firecrawl: () => unlocked(PAGES.recipeData) })
  r = await link(BLOG)
  check('site reachable → no Firecrawl request', r.body.via === 'direct' && scrapes().length === 0)

  // A real page without recipe data (it mentions ingredients): Firecrawl would
  // only fetch the same page again, so it isn't asked.
  resetForTests({}, 0.01, KEY)
  install({ direct: () => new Response(`<p>the ingredients</p>${filler}`), firecrawl: () => unlocked(PAGES.recipeData), replay: () => new Response(PAGES.plain) })
  await link(BLOG)
  check('page with signs of a recipe → no Firecrawl request', scrapes().length === 0)

  // Serious Eats: direct 403, Jina 451, Archive busy — Firecrawl brings the live page.
  resetForTests({}, 0.01, KEY)
  install({ replay: refused, firecrawl: () => unlocked(PAGES.recipeData) })
  r = await link()
  const photos = r.body.photos as { covers: string[]; stamp?: string; unlocker?: boolean }
  check('blocked site → imported via Firecrawl', r.status === 200 && r.body.via === 'unlocker', r.body)
  check('one Firecrawl request', scrapes().length === 1)
  check('photos can fall back to the Archive copy (stamp from the lookup)', photos.stamp === '20260810220319', photos)
  check('…and the app may ask Firecrawl for a photo as a last resort', photos.unlocker === true)
  check('the key goes only to Firecrawl', calls.filter((c) => (c.headers.get('Authorization') ?? '').includes(KEY)).every((c) => c.url.startsWith('https://api.firecrawl.dev/')))
  check('the tail shows credits left', logs.some((l) => l.includes('firecrawl on (987 credits left until 2026-10-27)')), logs.filter((l) => l.startsWith('link: ran')))
  check('the import line says Firecrawl brought it', /"firecrawl":"recipe"/.test(importLog()), importLog())

  // What Firecrawl is asked for.
  let asked: { formats?: string[]; proxy?: string; parsers?: unknown[]; onlyMainContent?: boolean } = {}
  resetForTests({}, 0.01, KEY)
  install({ replay: refused, firecrawl: (b) => ((asked = b as typeof asked), unlocked(PAGES.recipeData)) })
  await link()
  check('asked for raw HTML, whole page, auto proxy, no PDF parsing', JSON.stringify(asked.formats) === '["rawHtml"]' && asked.proxy === 'auto' && Array.isArray(asked.parsers) && asked.parsers.length === 0 && asked.onlyMainContent === false, asked)

  // The Archive answers first with a recipe: it wins, no waiting on Firecrawl.
  resetForTests({}, 0.01, KEY)
  install({ firecrawl: () => new Promise((res) => setTimeout(() => res(unlocked(PAGES.recipeData)), 150)) })
  r = await link()
  check('whichever brings a recipe first wins (the Archive here)', r.body.via === 'archive', r.body.via)

  // Firecrawl brings a block page: the Archive's copy is used.
  resetForTests({}, 0.01, KEY)
  install({ firecrawl: () => unlocked(PAGES.challenge, 403) })
  r = await link()
  check('site refused Firecrawl too → the Archive copy', r.body.via === 'archive' && /"firecrawl":"failed"/.test(importLog()), importLog())

  // Out of credits: the import carries on, and Firecrawl rests for hours.
  resetForTests({}, 0.01, KEY)
  install({ firecrawl: () => new Response('{"success":false,"error":"Insufficient credits"}', { status: 402 }) })
  r = await link()
  check('402 (out of credits) → import still works via the Archive', r.status === 200 && r.body.via === 'archive')
  check('…and says so in the tail', logs.some((l) => l.includes('out of free credits for this month')))
  install({ replay: refused, googleReads: (u) => u.startsWith('https://web.archive.org/'), firecrawl: () => unlocked(PAGES.recipeData) })
  r = await link()
  check('next import: Firecrawl not asked while paused', scrapes().length === 0 && r.body.via === 'google-archive', r.body.via)
  check('…the photo fallback isn’t offered either', !(r.body.photos as { unlocker?: boolean } | undefined)?.unlocker)
  clockAhead(7 * 60 * 60_000)
  install({ replay: refused, firecrawl: () => unlocked(PAGES.recipeData) })
  r = await link()
  check('hours later it tries again by itself', r.body.via === 'unlocker' && scrapes().length === 1, r.body.via)
  ;(globalThis as { Date: DateConstructor }).Date = RealDate

  // Too many a minute (free plan: 10/min): paused for a minute only.
  resetForTests({}, 0.01, KEY)
  install({ firecrawl: () => new Response('{}', { status: 429 }) })
  await link()
  check('429 → paused about a minute', logs.some((l) => l.includes('too many requests a minute') && l.includes('for 1 min')))

  // Wrong key: paused, with what to check.
  resetForTests({}, 0.01, KEY)
  install({ firecrawl: () => new Response('{}', { status: 401 }) })
  await link()
  check('401 → the tail says to check FIRECRAWL_API_KEY', logs.some((l) => l.includes('check FIRECRAWL_API_KEY')))

  // Photos: the last resort, passed straight through.
  resetForTests({}, 0.01, KEY)
  let photoAsk: { formats?: string[]; url?: string } = {}
  install({ firecrawl: (b) => ((photoAsk = b), new Response('{"success":true,"data":{"rawBase64":"/9j/4AAQ","metadata":{"statusCode":200,"contentType":"image/jpeg"}}}')) })
  let img2 = await handleImageProxy({ url: 'https://www.seriouseats.com/thmb/cover.jpg', paid: true }, 'https://app.example')
  const passed = await img2.text()
  check('paid photo → Firecrawl asked for the raw bytes (base64) of that photo', JSON.stringify(photoAsk.formats) === '["rawBase64"]' && photoAsk.url === 'https://www.seriouseats.com/thmb/cover.jpg', photoAsk)
  check('…its answer passed through as is, for the app to decode', img2.status === 200 && img2.headers.get('Content-Type') === 'application/json' && passed.includes('"rawBase64":"/9j/4AAQ"'))
  check('…and no free routes are retried first', calls.filter((c) => !c.url.startsWith('https://api.firecrawl.dev/')).length === 0, calls.map((c) => c.url))
  resetForTests({}, 0.01)
  install({})
  img2 = await handleImageProxy({ url: 'https://www.seriouseats.com/thmb/cover.jpg', paid: true }, 'https://app.example')
  check('paid photo without a key → 404, nothing fetched', img2.status === 404 && calls.length === 0)
}

// ---------------------------------------------------------------------------
section('sites that refuse everything')
resetForTests({}, 0.01)
install({})
r = await link('https://cooking.nytimes.com/recipes/1017518-panzanella')
check('NYT Cooking: answered at once, nothing fetched', r.status === 422 && r.body.code === 'site_refuses' && calls.length === 0, r.body)

// ---------------------------------------------------------------------------
section('the AI')
resetForTests({}, 0.01)
install({
  direct: () => new Response(PAGES.recipeData),
  gemini: (model) => (model === 'gemini-3.5-flash-lite' ? new Response('{"error":"quota"}', { status: 429 }) : (undefined as unknown as Response)),
})
r = await link(BLOG)
check('a 429 on the first model tries the next', r.status === 200 && googleCalls().length === 2, googleCalls().map((c) => c.url))

resetForTests({}, 0.01)
install({ direct: () => new Response(PAGES.recipeData), gemini: () => new Response('busy', { status: 503 }) })
r = await link(BLOG)
check('AI down after we got the page: code ai_busy, a plain message', r.status === 502 && r.body.code === 'ai_busy' && /overloaded/.test(String(r.body.error)), r.body)
check('…no "import as listed" payload any more', r.body.jsonld === undefined && r.body.photos === undefined)
check('…and the page was fetched once', calls.filter((c) => c.url === BLOG).length === 1)

// Slow but steady: the answer takes longer than the old 30 s cut-off (0.3 s
// here), arriving in pieces — now it's waited for.
resetForTests({}, 0.01)
install({ direct: () => new Response(PAGES.recipeData), gemini: () => sse(slices(AI_RECIPE, 6), 70) })
r = await link(BLOG)
check('a slow answer that keeps arriving is waited for (the real 31 s case)', r.status === 200 && googleCalls().length === 1, { status: r.status, calls: googleCalls().length, logs: logs.filter((l) => l.startsWith('gemini')) })

// Starts, then goes quiet: given up on after 15 s of silence; the next model answers.
{
  let n = 0
  resetForTests({}, 0.01)
  install({
    direct: () => new Response(PAGES.recipeData),
    gemini: (model) => (model === 'gemini-3.5-flash-lite' ? (n++, sse(slices(AI_RECIPE, 4), 0, 1)) : (undefined as unknown as Response)),
  })
  r = await link(BLOG)
  check('an answer that goes quiet mid-way → the next model', r.status === 200 && n === 1 && logs.some((l) => l.includes('went quiet for 15 s')), logs.filter((l) => l.startsWith('gemini')))
}
{
  // Stream ends with half an answer and no end marker → the next model.
  let n = 0
  resetForTests({}, 0.01)
  install({
    direct: () => new Response(PAGES.recipeData),
    gemini: (model) => (model === 'gemini-3.5-flash-lite' ? (n++, sse(slices(AI_RECIPE, 4).slice(0, 2))) : (undefined as unknown as Response)),
  })
  r = await link(BLOG)
  check('an answer cut off half-way → the next model', r.status === 200 && n === 1 && logs.some((l) => l.includes('stopped before it finished')), logs.filter((l) => l.startsWith('gemini')))
}
{
  // Never starts: given up on after 20 s (0.2 s here), not left hanging.
  resetForTests({}, 0.01)
  const t0 = Date.now()
  install({ direct: () => new Response(PAGES.recipeData), gemini: (model) => (model === 'gemini-3.5-flash-lite' ? ('hang' as unknown as Response) : (undefined as unknown as Response)) })
  r = await link(BLOG)
  check('an answer that never starts → given up on at 20 s, next model answers', r.status === 200 && Date.now() - t0 < 600 && logs.some((l) => l.includes('no answer started in 20 s')), logs.filter((l) => l.startsWith('gemini')))
}

// The real 0.47 log: the light model overloaded (503), the fuller one hanging.
// Now the light model gets one more try after a moment, and it answers.
{
  let lite = 0
  resetForTests({}, 0.01)
  install({
    direct: () => new Response(PAGES.recipeData),
    gemini: (model) =>
      model === 'gemini-3.5-flash-lite'
        ? ++lite === 1
          ? new Response('overloaded', { status: 503 })
          : (undefined as unknown as Response)
        : ('hang' as unknown as Response),
  })
  r = await link(BLOG)
  check('light model overloaded once → tried again after a moment → imported', r.status === 200 && lite === 2 && googleCalls().length === 2, googleCalls().map((c) => c.url))
  check('…and the fuller model was never needed', !googleCalls().some((c) => c.url.includes('gemini-3.5-flash:')))
  check('…the tail says so', logs.some((l) => l.includes('trying it again shortly')) && logs.some((l) => l.includes('once more (it was overloaded')))
}
{
  resetForTests({}, 0.01)
  const t0 = Date.now()
  install({
    direct: () => new Response(PAGES.recipeData),
    gemini: (model) => (model === 'gemini-3.5-flash-lite' ? new Response('overloaded', { status: 503 }) : ('hang' as unknown as Response)),
  })
  r = await link(BLOG)
  const ms = Date.now() - t0
  check('both overloaded/hung → ai_busy, having tried light twice then fuller once', r.body.code === 'ai_busy' && googleCalls().length === 3, googleCalls().map((c) => c.url))
  check('…a model that never starts is given up on at 20 s (0.2 s at test speed)', ms < 600, ms)
}
{
  // A 429 (its free quota) isn't retried on the same model — straight to the next.
  let lite = 0
  resetForTests({}, 0.01)
  install({
    direct: () => new Response(PAGES.recipeData),
    gemini: (model) => (model === 'gemini-3.5-flash-lite' ? (lite++, new Response('quota', { status: 429 })) : (undefined as unknown as Response)),
  })
  r = await link(BLOG)
  check('429 on the light model → no second try of it, the fuller one answers', r.status === 200 && lite === 1)
}
{
  resetForTests({}, 0.01)
  install({ direct: () => new Response(PAGES.recipeData) })
  await link(BLOG)
  const line = logs.find((l) => l.startsWith('link: ran in')) ?? ''
  check('the tail names the outside view of our address and the Worker version', line.includes('outgoing address 104.28.1.1 (outside Cloudflare') && /worker \d+\.\d+\.\d+/.test(line), line)
}

resetForTests({}, 0.01)
install({
  direct: () => new Response(PAGES.plain),
  replay: () => new Response(PAGES.plain),
  googleReads: (u) => u === BLOG,
  gemini: (_m, body) => (body.tools ? (undefined as unknown as Response) : new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: '{"not_a_recipe":true,"title":"","ingredients":[],"steps":[]}' }] } }] }))),
})
r = await link(BLOG)
check('a signless page the AI calls "not a recipe" → Google reads the link', r.status === 200 && r.body.via === 'google', r.body)

// ---------------------------------------------------------------------------
section('photos')
resetForTests({}, 0.01)
install({})
globalThis.fetch = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
  calls.push({ url: String(input), headers: new Headers(init.headers) })
  // No Content-Length: a stream of 13 MB, over the cap.
  const chunk = new Uint8Array(1_000_000)
  let sent = 0
  const body = new ReadableStream<Uint8Array>({
    pull(c) {
      if (sent++ >= 13) c.close()
      else c.enqueue(chunk)
    },
  })
  return new Response(body, { headers: { 'Content-Type': 'image/jpeg' } })
}) as typeof fetch
const img = await handleImageProxy({ url: 'https://img.example/huge.jpg' }, 'https://app.example')
let size = 0
let cut = false
try {
  const reader = img.body!.getReader()
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    size += value.byteLength
  }
} catch {
  cut = true
}
check('an image with no declared size is cut off at 12 MB', cut && size <= 12_000_000, { size, cut })
check('photo requests say who we are too', (calls[0]?.headers.get('User-Agent') ?? '').startsWith('CuratedKitchen/1.0'))

// ---------------------------------------------------------------------------
section('sign-in check')
resetForTests({}, 0.01)
install({})
globalThis.fetch = (async () => {
  throw new TypeError('network down')
}) as typeof fetch
const b64 = (o: unknown) => btoa(JSON.stringify(o)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
const now = Math.floor(Date.now() / 1000)
const token = `${b64({ alg: 'RS256', kid: 'k1' })}.${b64({ aud: 'test', iss: 'https://securetoken.google.com/test', sub: 'u1', exp: now + 600, iat: now })}.c2ln`
const res = await worker.fetch(
  new Request('https://w.example/', { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: '{"url":"https://x.example/"}' }),
  env as never,
)
check("Google's key server down → 503 with CORS, not a crash", res.status === 503 && res.headers.get('Access-Control-Allow-Origin') !== null, res.status)

// ---------------------------------------------------------------------------
section('progress, as it happens')
{
  resetForTests({}, 0.01)
  install({ direct: () => new Response(PAGES.recipeData), gemini: () => sse(slices(AI_RECIPE, 3)) })
  const seenStages: Array<Record<string, unknown>> = []
  const done = await importJob({ url: BLOG }, env as never, (st) => seenStages.push(st as Record<string, unknown>))
  const names = seenStages.map((st) => st.stage)
  check('a link reports: opening → reading → writing… → finishing', done.status === 200 && names[0] === 'opening' && names.includes('reading') && names.includes('writing') && names.at(-1) === 'finishing', names)
  check('…opening names the site', seenStages[0].host === 'smallblog.example')
  const last = seenStages.filter((st) => st.stage === 'writing').at(-1)
  check('…and counts what the AI has written (1 ingredient, 1 step)', last?.ingredients === 1 && last?.steps === 1, last)
  check('…no "another way" when the site let us in', !names.includes('another-way'))

  seenStages.length = 0
  resetForTests({}, 0.01)
  install({ replay: refused, googleReads: (u) => u.startsWith('https://web.archive.org/') })
  await importJob({ url: URL_ }, env as never, (st) => seenStages.push(st as Record<string, unknown>))
  check('a blocked site says it’s trying another way', seenStages.some((st) => st.stage === 'another-way'), seenStages.map((st) => st.stage))

  seenStages.length = 0
  resetForTests({}, 0.01)
  install({})
  const textDone = await importJob({ text: 'Soup\nIngredients\n1 carrot\nMethod\nBoil.' }, env as never, (st) => seenStages.push(st as Record<string, unknown>))
  check('pasted text: reading → … → finishing, and the recipe', textDone.status === 200 && seenStages[0].stage === 'reading' && seenStages.at(-1)?.stage === 'finishing' && !!textDone.body.recipe)
}
// ---------------------------------------------------------------------------
section('the import queue: everyone gets their own')
{
  // A real signed sign-in token, from a key this test makes, so the Worker's
  // own sign-in check runs.
  const keys = (await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['sign', 'verify'],
  )) as CryptoKeyPair
  const jwk = (await crypto.subtle.exportKey('jwk', keys.publicKey)) as JsonWebKey
  const b64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  const enc = (o: unknown) => b64url(new TextEncoder().encode(JSON.stringify(o)))
  const tokenFor = async (uid: string) => {
    const now = Math.floor(RealDate.now() / 1000)
    const head = `${enc({ alg: 'RS256', kid: 'test-key' })}.${enc({ aud: 'test', iss: 'https://securetoken.google.com/test', sub: uid, exp: now + 600, iat: now })}`
    const sig = new Uint8Array(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', keys.privateKey, new TextEncoder().encode(head)))
    return `${head}.${b64url(sig)}`
  }
  resetForTests({}, 0.01)
  install({})
  const base = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) =>
    String(input).includes('securetoken@system.gserviceaccount.com')
      ? new Response(JSON.stringify({ keys: [{ ...jwk, kid: 'test-key' }] }))
      : base(input, init)) as typeof fetch
  const opened: string[] = []
  const QUEUE = {
    idFromName: (name: string) => `id-of-${name}`,
    get: (id: unknown) => ({
      fetch: async (req: Request) => {
        opened.push(`${String(id)} ${new URL(req.url).pathname} ${await req.text()}`)
        return new Response('{"items":[]}')
      },
    }),
  }
  const ask = async (uid: string, action: string, body: unknown, withQueue = true) =>
    worker.fetch(
      new Request(`https://w.example/queue/${action}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${await tokenFor(uid)}` },
        body: JSON.stringify(body),
      }),
      { ...env, ...(withQueue ? { QUEUE } : {}) } as never,
    )
  let res = await ask('alice', 'list', {})
  check('a signed-in cook reaches their queue', res.status === 200 && opened[0]?.startsWith('id-of-alice /list'), opened)
  check('…with CORS for the app', res.headers.get('Access-Control-Allow-Origin') !== null)
  res = await ask('bob', 'remove', { id: 'x', uid: 'alice' })
  check('the queue is chosen by the sign-in, never the request (bob can’t reach alice’s)', opened[1]?.startsWith('id-of-bob /remove'), opened)
  res = await ask('alice', 'list', {}, false)
  check('a Worker without the queue says so (501, no_queue)', res.status === 501 && ((await res.json()) as { code?: string }).code === 'no_queue')
  const noToken = await worker.fetch(new Request('https://w.example/queue/list', { method: 'POST', body: '{}' }), { ...env, QUEUE } as never)
  check('no sign-in, no queue', noToken.status === 401 && opened.length === 2)
  // Notifications: the cook's own notifier, and the queue is told whose it is.
  const heard: string[] = []
  const NOTIFY = {
    idFromName: (name: string) => `notifier-of-${name}`,
    get: (id: unknown) => ({
      fetch: async (req: Request) => {
        heard.push(`${String(id)} ${new URL(req.url).pathname} internal=${req.headers.get('X-Internal')}`)
        return new Response('{"publicKey":"k"}')
      },
    }),
  }
  const viaWorker = async (uid: string, path: string, extra: Record<string, unknown> = {}, headers: Record<string, string> = {}) =>
    worker.fetch(
      new Request(`https://w.example/${path}`, { method: 'POST', headers: { Authorization: `Bearer ${await tokenFor(uid)}`, ...headers }, body: '{}' }),
      { ...env, QUEUE, NOTIFY, ...extra } as never,
    )
  res = await viaWorker('alice', 'notify/key')
  check('notify/* → the cook’s own notifier (by sign-in)', res.status === 200 && heard[0] === 'notifier-of-alice /key internal=null', heard)
  await viaWorker('alice', 'notify/send', {}, { 'X-Internal': '1' })
  check('…and the app can’t pose as the queue (X-Internal isn’t passed on)', heard[1] === 'notifier-of-alice /send internal=null', heard)
  const told: string[] = []
  await viaWorker('carol', 'queue/list', {
    QUEUE: { idFromName: (n: string) => n, get: () => ({ fetch: async (req: Request) => (told.push(req.headers.get('X-Uid') ?? ''), new Response('{}')) }) },
  })
  check('the queue is told whose it is (to notify them)', told[0] === 'carol')
  res = await viaWorker('alice', 'notify/key', { NOTIFY: undefined })
  check('a Worker without the notifier says so (501, no_notify)', res.status === 501 && ((await res.json()) as { code?: string }).code === 'no_notify')

  // The streamed route the app uses for photos/PDFs: one JSON line per step, then the answer.
  const streamRes = await worker.fetch(
    new Request('https://w.example/', {
      method: 'POST',
      headers: { Authorization: `Bearer ${await tokenFor('alice')}` },
      body: JSON.stringify({ text: 'Soup\nIngredients\n1 carrot\nMethod\nBoil.', stream: true }),
    }),
    env as never,
  )
  const lines = (await streamRes.text()).trim().split('\n').map((l) => JSON.parse(l) as { progress?: { stage: string }; status?: number; body?: { recipe?: unknown } })
  check('stream: newline-delimited JSON, with CORS', streamRes.headers.get('Content-Type') === 'application/x-ndjson' && streamRes.headers.get('Access-Control-Allow-Origin') !== null)
  check('…progress lines first (reading … finishing)', lines[0].progress?.stage === 'reading' && lines.some((l) => l.progress?.stage === 'finishing'), lines.map((l) => l.progress?.stage ?? l.status))
  check('…then the answer, as the plain route gives it', lines.at(-1)?.status === 200 && !!lines.at(-1)?.body?.recipe)
}

console.log = realLog
console.log(`\n${passed} passed, ${failed} failed`)
if (failed) (globalThis as { process?: { exit(code: number): never } }).process?.exit(1)
