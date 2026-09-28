# Curated Kitchen code review addendum

This addendum reads the actual source (`worker/src/index.ts` at 1,395 lines, the client import modules, the scripts, the workflow and `wrangler.toml`) against the research report, which was written from `CLAUDE.md` alone. Line numbers refer to the staged snapshot. Where the code is ambiguous I say so rather than guess. The report's general findings are referenced, not repeated.

## 1. The pipeline as actually implemented

**Client entry.** "Add from URL" lands in `readLink` (`src/routes/AddRecipePage.tsx:233-268`), which calls `readLinkOnce` (`:213-228`). With AI enabled (`src/lib/aiConfig.ts:33-35`, `IMPORT_WORKER_URL` at `:19`) it POSTs `{ url }` to the Worker root via `importRecipeViaAI` (`src/data/aiImport.ts:52-56`). On any non-422 failure it falls back to the free `/url` route (`AddRecipePage.tsx:221-223`, `src/data/urlImport.ts:36-40`), which converts JSON-LD client-side with `recipeFromJsonLd` (`src/lib/importRecipe.ts:266-352`). A 422 is treated as terminal because the Worker "already tried everything" (`AddRecipePage.tsx:218-221`). The AI result is tidied by `sanitizeAiRecipe` (`aiImport.ts:78`, `src/lib/aiRecipe.ts:137-199`), `source.url` is overwritten with the pasted link (`aiImport.ts:87-88`), validated by `parseRecipe` (`:100`), and only then are photos attached (`:105`).

**Worker dispatch.** `fetch` (`worker/src/index.ts:1324-1395`) verifies a Firebase ID token on every POST (`:1342-1346`, `verifyFirebaseToken` `:204-247`, JWKS fetched per request `:227-229`), parses the body, and routes by path suffix: `/url` → `handleUrlImport` (`:1362`, `:1036-1064`), `/img` → `handleImageProxy` (`:1364`, `:852-932`), else the AI route, where a bare `{ url }` goes to `handleLink` (`:1389`, `:967-1034`) and text/images go to `handleGemini` (`:1086-1271`).

**The fetch ladder** is `fetchRecipePage` (`:571-673`), and its acceptance rule matters: `consider` (`:574-586`) only accepts a page outright if `findRecipe(extractJsonLd(html))` succeeds (`:576`); otherwise a page over 5,000 chars whose first 5,000 chars don't match the challenge regex (`:582`) is stored as `fallback` only if nothing was stored before (`:584`), and the ladder continues. In order: (1) direct fetch with `BROWSER_HEADERS` (`:594`), skipped only for private hosts (`isBlockedHost` `:253-267`); (2) Jina Reader `https://r.jina.ai/<url>` with `X-Return-Format: html`, no API key and no User-Agent (`:595`); (3) archive.org, keyed by `archiveKey(url)` (`:525-536`, strips the fragment and `utm_*`/`fbclid`/`gclid`/`mc_*`/`ref`/`src`): Availability API `https://archive.org/wayback/available?url=…` (`:604-610`); if it names a timestamp, one replay `https://web.archive.org/web/<ts>id_/<url>` via `readCopy` (`:625-646`, URL at `:627`); if it returns nothing, a replay at `now` (`:655-656`) and the redirect target's timestamp is read back from `FetchInfo.url` (`:632`); if the copy isn't a recipe page, CDX `…/cdx/search/cdx?url=…&output=json&fl=timestamp,statuscode,mimetype&fastLatest=true&limit=-10` (`:544-546`), filtered client-side to `200`/`html` (`:555-558`), then up to two more replays (`:662`, `:668-671`). A replay refused with 429/503 (`busy` `:602`, `:638`) sets `archiveBusy` (`:639`) and asks Jina to fetch the archive URL instead (`:643`). All archive requests carry `ARCHIVE_UA` (`:319`) plus the session cookie from `archiveHeaders` (`:434-437`); the Worker signs in via `POST archive.org/services/xauthn/?op=login` (`:381-385`), keeps `logged-in-user`/`logged-in-sig` in module memory (`:335`, `:396`), renews a day before expiry (`:405-406`) and backs off ten minutes after a failed sign-in (`:373`). `scripts/archive-login.mjs` performs the same login (`:64-94`) and stores `ARCHIVE_SESSION`/`ARCHIVE_EMAIL`/`ARCHIVE_PASSWORD` through `wrangler secret bulk` (`:98-111`, `:130-134`).

**Retry and backoff.** Every fetch goes through `fetchText` (`:462-504`) with a 20 s abort (`:471`) and `redirect: 'follow'` (`:474`). It contains a retry loop, but all seven call sites pass `[]` or omit `retries` (`:544-551`, `:594`, `:595`, `:604-610`, `:631`, `:643`), so `attempt >= retries.length` (`:489`) returns `null` on the first 429/503. `Retry-After` is parsed (`:443-450`) and logged (`:479-480`) but the only branch that acts on it (`:490-493`) is unreachable. There is no memento-datetime check and no breaker state. Client-side, `readLink` loops while `isArchiveBusy` (`AddRecipePage.tsx:247`, `src/lib/archiveBusy.ts:16-19`) with waits of 40/50/60 s (`archiveBusy.ts:12`, `AddRecipePage.tsx:250-253`): four tries, each of which is a complete Worker call, i.e. the whole ladder again.

**Gemini.** `handleGemini` POSTs to `https://generativelanguage.googleapis.com/v1beta/models/<m>:generateContent` with `x-goog-api-key` (`:1135-1138`), models `gemini-3.5-flash-lite` then `gemini-3.5-flash` unless `GEMINI_MODEL` pins one (`:1099-1100`), `systemInstruction` = `SYSTEM` (`:1118`, `:161-175`), `generationConfig { temperature: 0, responseMimeType: 'application/json', maxOutputTokens: 16384, responseSchema }` (`:1111-1116`) where the schema is `RECIPE_TOOL.input_schema` (`:52-159`), and `tools: [{ url_context: {} }]` only when the input carries a URL (`:1123`). Abort is 45 s for a URL-context call, 30 s otherwise (`:1132`). A 5xx or a fallback-model 404 moves to the next model (`:1159-1166`); a 400 retries the same model once without the schema (`:1167-1172`); anything else, including 429, breaks the loop (`:1175`) and surfaces as a 502 (`:1183-1191`). For a fetched page the prompt is `pageForAi` (`:694-704`): the URL, the whole Recipe node stringified (`:699`), and `htmlToText(html).slice(0, 40_000)` (`:696`, tag-stripping regexes at `:676-690`). Only when no rung produced a page does `handleLink` call Gemini with the bare URL (`:979-980`, prompt at `:1075`) and require `URL_RETRIEVAL_STATUS_SUCCESS` (`:1205-1223`).

**Photos.** `findLinkPhotos` (`:807-827`) reads JSON-LD `image` and `og:image` (`:809`, `:815`), every `HowToStep.image` (`:819-825`, ≤3 per step, budget 9), and merges in same-stem sizes from `pageImageIndex` (`:771-795`, stems via `photoStem` `:759-766`), archive-shown sizes first for an archive page (`:813`). Step photos are attached only when Gemini's step count equals the page's (`:1013`). The client downloads through `POST /img` three at a time (`aiImport.ts:189-193`), each with a `stamp` (`:136`). `handleImageProxy` tries site → wsrv.nl-of-archive-`im_` → archive direct (only if wsrv.nl was down, `:889`, `:907`, `:912`) → wsrv.nl-of-site (`:874-883`, `viaImageProxy` `:845`), sending no Referer, an image `Accept` (`:900`) and `BROWSER_HEADERS` to everything but archive.org (`:899`), 15 s to headers (`:893`), then streams the body when `Content-Type` starts with `image/` and `Content-Length` ≤ 12 MB (`:913-921`). `compressToDataUrl` (`src/data/photos.ts:89-105`) shrinks each to ≤ 900,000 chars (`:25`) for a Firestore `photos` doc (`:237-249`).

**GitHub Actions.** `.github/workflows/import-recipe.yml` is a manual `workflow_dispatch` (`:11-16`) on `ubuntu-latest` (`:23`) running `scripts/import-url.ts` (`:37`): one Node fetch with a Safari 17 User-Agent (`import-url.ts:23-24`, `:40`), no fallbacks, exits on 401/402/403/429 (`:42-47`), regex JSON-LD extraction (`:26-38`), writes `recipes/<slug>.json` (`:74-78`) and commits it (`import-recipe.yml:42-52`). Its header says the push "runs the sync workflow and lands it in Firestore" (`:5-7`), but `CLAUDE.md:55-68` says that sync is retired. So this path is owner-only, writes a file nothing consumes, and fetches from an Azure datacenter IP with the same UA/TLS contradiction as the Worker; it is not a practical alternative route (F14).

## 2. Where the report's description was right, wrong, or incomplete

- **BROWSER_HEADERS / impersonation — right, and worse than described.** A Chrome 125 macOS UA (`index.ts:306-307`) with a three-header set (`:304-310`); no `sec-ch-ua`, `sec-fetch-*` or `upgrade-insecure-requests`, which every real Chrome 125 sends. Used on the direct fetch (`:594`) and on `/img` (`:899`). Jina calls send no UA at all (`:595`, `:643`).
- **ARCHIVE_UA — right** (`:319`, applied at `:383`, `:436`).
- **logged-in-user / logged-in-sig — right** (`:391-396`; `archive-login.mjs:84-90`); sent only to archive hosts (`:547`, `:606`, `:631`, `:899`). The 0.43 `ARCHIVE_COOKIES` fallback is honoured with `expires: Infinity` (`:363`).
- **40/50/60 s four-try loop — right in timing, incomplete in scope.** `[40, 50, 60]` (`archiveBusy.ts:12`) and `retry >= ARCHIVE_BUSY_WAITS.length` (`AddRecipePage.tsx:247`) give four tries. But each try is the full ladder, not one archive request (section 3, F2).
- **v0.42.5 retry removal — right, and broader:** nothing is retried Worker-side; the loop in `fetchText` is dead code for all callers (`:489`).
- **CDX query string — right, verbatim** (`:545-546`).
- **400 → retry without responseSchema — right** (`:1167-1172`), but see F8 on why the schema-less retry probably can't produce a parseable answer.
- **Flash-Lite → Flash fallback, 30 s aborts — right with two differences:** 45 s for URL-context calls (`:1132`), and a 429 does not fall through to the next model (`:1175`, `:1187-1188`).
- **URL context + structured output — right** (`:1116`, `:1123`); the URL rides only in the user prompt text (`:1075`).
- **URL_RETRIEVAL_STATUS_ERROR — right** (`:1210-1222`); missing metadata is let through (`:1210`).
- **Jina 451 — incomplete:** there is no 451-specific code; any non-OK, non-400, non-429/503 status returns `null` (`:488-489`). Functionally equivalent, but the important detail the report missed is that the keyless 20 RPM limit is per IP, so it is shared with every other Workers tenant calling `r.jina.ai` — the archive.org collision in miniature.
- **pageImageIndex / pageImageVariants — partly wrong naming.** `pageImageVariants` does not exist; the behaviour is `pageImageIndex` (`:771`) plus the `candidates` closure in `findLinkPhotos` (`:811-814`). `CLAUDE.md:149` is stale.
- **archiveKey — right** (`:525-536`) but used only for archive lookups (`:601`); the report's rung 0 ("cache by canonical URL") does not exist anywhere in the code.
- **Firebase ID-token check — right** (`:1341-1346`), applied to `/url` and `/img` too. It checks the token's project, not household membership; any account in the Firebase project can call the Worker. Since accounts are console-created (`README.md:21-27`) that is fine.
- **Exact-step-count rule — right** (`:1013`).
- **Firestore data-URL photos, ~1 MB — right** (`photos.ts:25-29`, `:89-105`).
- **Not in the report:** the `/url` client converter, the Anthropic fallback (`:1275-1322`), the `api.ipify.org` call on every link import (`:958`, `:972`), and the Actions workflow.

## 3. Concrete findings

**F1. archive.org 429s are neither classified nor honoured, and each refused attempt still spends three rationed requests.** A 429 is only checked for status (`:477`), never for `memento-datetime` (a replayed capture of the *site's* 429, which the report notes must not trip a breaker) and `Retry-After` is logged and discarded (`:479-480`). When the availability lookup is refused (`:604`), `quick` is undefined so the code still fetches the `now` replay (`:656`), which is refused again, and then still queries CDX (`:662`) before concluding "too busy to check" (`:663-667`). That is three archive.org requests per attempt while already throttled, from the address the report explains is being metered. No state survives to the next friend's import seconds later.

**F2. The client loop hammers in slow motion, as the report feared, but through the whole ladder.** On `archive_busy` (`:989-998`) the app waits 40 s and calls the Worker again (`AddRecipePage.tsx:240-258`), which reruns direct fetch, Jina, three archive requests, Jina-of-archive (`:643`) and a Gemini URL-context call (`:980`). Four tries ≈ 12 archive.org requests, 8 Jina requests and 4 Gemini calls in three minutes, per user, from a blocked address. Each try also takes 60–90 s of its own (20 s aborts at `:471`, Jina's ~8 s, 45 s Gemini at `:1132`) before the countdown starts, so a Serious Eats link can occupy a friend for 7–8 minutes. Separately, any non-422 error (a Gemini 502, a network blip) triggers the `/url` fallback (`AddRecipePage.tsx:223`), which reruns the ladder again (`:1054`).

**F3. The ladder is "JSON-LD or bust", so ordinary pages burn the archive budget.** Because `consider` only accepts a page with a Recipe node (`:576`), a 200 from a microdata-only site (Epicurious in the report's corpus) or any blog without structured data still goes to Jina (`:595`) and archive.org (`:604` onward) before the direct page is used as `fallback` (`:672`). The page was already in hand; the archive requests were pure cost.

**F4. The direct fetch impersonates, and inconsistently.** `:304-310` with `:594`; see section 2. This is the cross-layer contradiction the report describes, plus an intra-layer one: a Chrome UA without Chrome's client hints. The Jina fetches (`:595`, `:643`) go out with no `User-Agent` at all, the bare-runtime signature the report documents.

**F5. Challenge pages returning 200 can win.** Detection is five phrases over the first 5,000 chars (`:582`); HUMAN/PerimeterX ("Press & Hold"), Kasada, Imperva and consent walls don't match. Worse, `fallback` is first-come (`:584`): a soft-block from the direct fetch that beats the regex outranks a real page Jina returns a moment later, and `handleLink` then sends the junk to Gemini, gets `not_a_recipe` (`:1248-1250`), returns 422 (`:1002`), and never reaches URL context because that branch requires `!page` (`:979`).

**F6. JSON-LD is parsed by regex over the buffered body, several times, under a 10 ms CPU budget.** `extractJsonLd` (`:270-286`) and `findRecipe` (`:289-302`) run in `consider` for every rung tried (`:576`), again in `pageForAi` (`:695`), again in `findLinkPhotos` (`:808`); `htmlToText` adds twelve full-body replaces (`:676-690`), `pageImageIndex` another scan (`:773`), plus the `og:image` regex (`:809`). Five or six JS passes over a 0.5–1.5 MB ad-laden page is where the Free plan's 10 ms goes; `CLAUDE.md:156-158` shows you have already hit this wall once. `findRecipe` also descends only into arrays and `@graph` (`:293`, `:298`), missing `WebPage.mainEntity`, and compares `@type` case-sensitively (`:297`); the client's `findRecipeNode` has the same two gaps (`importRecipe.ts:250-262`).

**F7. What Gemini receives.** Per link: `SYSTEM` ≈ 2,550 chars (`:161-175`, ~650 tokens), the schema ≈ 4,000 chars compacted (`:52-159`, ~1,000 tokens plus the tag enum), the Recipe node uncapped (`:699` — Allrecipes-style nodes carry hundreds of `review` entries and a `video` object), and up to 40,000 chars of text (`:696`, ~10k tokens). Typical total 12–16k input tokens and 1.5–3k output; on Flash-Lite list prices about a cent, on the free tier a rate-limit slot. The text is truncated from the head, so on a long blog *without* JSON-LD — the only case the text matters — the recipe card at the bottom is what gets cut.

**F8. Schema and fallback.** Depth reaches four (`ingredients.items.alt.properties` `:101-105`; `steps.items.timers.items` `:117-124`), `required` appears five times (`:76`, `:107`, `:123`, `:135`, `:157`), three enums (`:100`, `:129-130`, `:142`), and `description` strings on most properties. No `pattern`/`format`, so rejection risk is moderate rather than likely. The real problem is the 400 fallback (`:1167-1172`): it drops the schema, but the JSON key names (`prepMin`, `yield.amount`, `steps[].text`, `handsOff`, …) exist *only* in the schema; `SYSTEM` describes fields in prose and still says "by calling the save_recipe tool" (`:161`), a tool Gemini doesn't have. A schema-less answer will use whatever keys the model invents and fail `sanitizeAiRecipe` (`aiRecipe.ts:152-156`). Also, a per-model 429 (quotas are per model) ends the loop instead of trying `gemini-3.5-flash` (`:1175`, `:1183-1191`).

**F9. Image fetching.** No Referer and a proper image `Accept` (`:898-901`) are right per the report's hotlink analysis. Content-type is prefix-checked only (`:915`), no magic-byte check; a missing `Content-Length` makes `size` 0 and passes unbounded (`:914-915`). The site route uses the Chrome UA (`:899`). On the client, the editor cannot open until every photo's candidate list is exhausted (`aiImport.ts:105`, `:164-193`): up to four candidates × four routes × 15 s each (`:893`) per photo, with no overall deadline.

**F10. No cache, no coordination.** Nothing stores a fetched page, a snapshot answer or a Gemini result; `archiveKey` is computed (`:601`) but never used as a cache key. Two friends importing the same URL, or one retry, cost everything twice. Module state (`:334-337`, `:944-948`) is per isolate, so there is no per-host concurrency control across users, and the three parallel `/img` calls (`aiImport.ts:193`) are three concurrent hits on one CDN host from one egress.

**F11. Secrets are handled correctly; two robustness nits.** The Gemini key goes only to Google (`:1138`), the password only to the login endpoint (`:381-384`), the cookie only to archive hosts. But the JWKS fetch has no timeout and no `try/catch` (`:227-229`): a hiccup throws out of `fetch`, the runtime answers 500 without CORS headers, the browser reports "Failed to fetch", and the F2 `/url` rerun follows. And `isBlockedHost` runs before `redirect: 'follow'` (`:594` vs `:474`; `:859` vs `:902`), so a redirect into a private range is not re-checked; low risk given members-only access.

**F12. Two silent quality downgrades, contrary to `CLAUDE.md:20-26`.** A URL-context success returns a recipe with no `photos` key and no marker (`:981` returns `google` as-is), so the editor opens a photo-less import with no explanation. And the `/url` fallback after a Gemini 5xx (`AddRecipePage.tsx:223`) yields plain-text steps, guessed aisles and no `brief`, with `recipeFromJsonLd`'s warnings dropped by `.seed`. `recipeFromJsonLd` also never decodes entities (`importRecipe.ts:275`), so `2 &frac12; pounds` becomes item `"&frac12; pounds ripe peaches"`.

**F13. `wrangler.toml`.** `compatibility_date = "2024-11-01"` (`:3`) is nearly two years old; there is no `[observability]` block, so logs exist only while someone runs `wrangler tail`, at odds with the owner-not-on-call goal; no bindings. `worker/README.md:61-62` still asks the owner to replace a placeholder `wrangler.toml:9` no longer contains, and `README.md:166-169` says the Worker "waits out" 429s, which stopped in 0.42.5.

**F14. The Actions path** (section 1) is dead as a route and weak as a relay: dispatching it needs a PAT and `repository_dispatch`, a runner takes 30–60 s to start, the result lands in git, not the app, and the runner IP is datacenter. Delete it or keep it as owner tooling. `run: … "${{ inputs.url }}"` (`import-recipe.yml:37`) is the classic expression-injection pattern; harmless while only the owner can dispatch.

**F15. Timeouts read as "missing".** A 20 s abort on a replay leaves `status` undefined (`:496`), `busy()` is false, and `readCopy` returns `'missing'` (`:638`), so a slow archive.org proceeds to CDX and two more replays: up to 100 s of waiting on a host that is struggling.

## 4. Prioritized changes

All are Free-plan compatible unless marked.

**1. A real archive.org breaker (Worker, `fetchText`/`fetchRecipePage`).** Classify the 429, honour `Retry-After`, open a module-level breaker with the report's 60 s → 1 h → doubling schedule, and skip *every* archive rung while it is open, returning `archive_busy` at once. Reset on any 200.

```ts
let archiveBlockedUntil = 0, archiveStrikes = 0
const archiveOpen = () => Date.now() >= archiveBlockedUntil
function noteArchive(res: Response) {
  if (res.ok) { archiveStrikes = 0; return }
  // A 429 carrying memento-datetime is a replayed capture of the SITE's 429, not IA's throttle.
  if (res.status !== 429 || res.headers.get('memento-datetime')) return
  const asks = retryAfterMs(res) ?? 0
  const base = archiveStrikes === 0 ? 60_000 : Math.min(4 * 3_600_000, 3_600_000 * 2 ** (archiveStrikes - 1))
  archiveStrikes++
  archiveBlockedUntil = Date.now() + Math.max(asks, base) + Math.random() * 5_000
}
// in fetchRecipePage, before line 604: if (!archiveOpen()) { seen.archiveBusy = true; return fallback }
```

**2. Stop the client from replaying the ladder (`readLink`, `handleLink`).** Have the Worker put `retryAfterMs` in the `archive_busy` body from the breaker, and make the retry re-enter only the archive rung (`{ url, rung: 'archive' }` → skip `:594-596`), at most once, only when the breaker has closed. Never call `/url` after an AI-route failure that already fetched the page; instead have `handleLink` include the JSON-LD blocks in its error body so the client can degrade *visibly* (see 9).

**3. Accept a good direct page before touching Jina or the archive (`consider`).** Treat a 2xx body as final when it has any recipe signal, not only JSON-LD, and escalate only on non-2xx, a challenge, or a tiny body:

```ts
const RECIPE_SIGNAL = /itemtype=["'][^"']*schema\.org\/Recipe|wprm-recipe|tasty-recipes|>\s*Ingredients\s*<|recipeIngredient/i
const looksLikeRecipe = (html: string) => RECIPE_SIGNAL.test(html)
```

Score `fallback` by signal strength rather than first-come, so a Jina page with signals replaces a signal-free direct page (fixes F3 and half of F5).

**4. Identify honestly (`BROWSER_HEADERS` → `APP_HEADERS`).** Replace `:304-310` and use it at `:594` and `:899`; add it to the Jina calls too.

```ts
const APP_HEADERS = {
  'User-Agent': 'CuratedKitchen/1.0 (+https://cwang427.github.io/curated-kitchen/; one page per member request)',
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
}
```

Per the report, this converts a "spoofing" score to a "generic automation" score; it will not pass Bot Fight Mode, which nothing from a Worker passes.

**5. One streaming pass with `HTMLRewriter`; parse JSON-LD once; trim the node.** Replace `res.text()` plus the five regex passes with a single collector fed straight from the response stream, then reuse its output in `pageForAi` and `findLinkPhotos` (they currently re-derive everything, `:695`, `:808`). Before stringifying for Gemini, delete `review`, `comment`, `aggregateRating`, `video`, `publisher`, `isPartOf`, `mainEntityOfPage`.

```ts
async function scan(res: Response) {
  const ld: string[] = [], og: string[] = [], imgs: string[] = [], text: string[] = []; let cur = ''
  await new HTMLRewriter()
    .on('script[type="application/ld+json"]', { text(t) { cur += t.text; if (t.lastInTextNode) { ld.push(cur); cur = '' } } })
    .on('meta[property="og:image"]', { element(e) { const c = e.getAttribute('content'); if (c) og.push(c) } })
    .on('img, source', { element(e) { for (const a of ['src', 'srcset', 'data-src', 'data-srcset', 'data-lazy-src']) { const v = e.getAttribute(a); if (v) imgs.push(v) } } })
    .on('h1, h2, h3, p, li', { text(t) { text.push(t.text); if (t.lastInTextNode) text.push('\n') } })
    .transform(res).body!.pipeTo(new WritableStream())
  return { jsonld: ld.flatMap((s) => { try { return [JSON.parse(s)] } catch { return [] } }), og, imgs, text: text.join('') }
}
```

(Nested `li > p` double-collects text; dedupe or collect only `p, li` if that shows up.) Also extend `findRecipe` to descend into `mainEntity` and compare `@type` case-insensitively, in both the Worker and `importRecipe.ts`.

**6. A Jina API key (Worker secret `JINA_API_KEY`).** `headers: { Authorization: \`Bearer ${env.JINA_API_KEY}\`, 'X-Return-Format': 'html', 'X-Timeout': '15' }` at `:595` and `:643`. Free key; moves the 20 RPM per-IP budget shared with every Workers tenant to a 500 RPM per-key one, per the report.

**7. Gemini hardening (`handleGemini`).** Let 429 `continue` to the next model (`:1175`). Give the schema-less retry a chance by appending a compact key skeleton to the prompt when `useSchema` is false (`{"title":"","yield":{"amount":4,"unit":"servings"},"times":{"prepMin":0,"cookMin":0,"totalMin":0},"ingredients":[{"quantity":1,"unit":"cup","item":"","category":"pantry"}],"steps":[{"text":"","brief":[""],"handsOff":false}],"tags":[]}`). Flatten `alt` and `temperature` into scalar fields (`altQuantity`, `altUnit`, `tempValue`, `tempUnit`) and express optional numbers as `["number","null"]`, taking the schema to depth three. Remove "by calling the save_recipe tool" from `SYSTEM` for the Gemini path.

**8. An unlocker rung between Jina and the archive — needs an account; the free tier is reported as card-free, confirm before relying on it.** The one server-side channel whose IP and fingerprint are not the Worker's:

```ts
async function viaUnlocker(url: string, env: Env): Promise<string | null> {
  if (!env.BRIGHTDATA_API_KEY) return null
  const res = await fetch('https://api.brightdata.com/request', {
    method: 'POST', signal: AbortSignal.timeout(25_000),
    headers: { Authorization: `Bearer ${env.BRIGHTDATA_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ zone: env.BRIGHTDATA_ZONE, url, format: 'raw' }),
  })
  return res.ok ? res.text() : null
}
```

Check the exact body against Bright Data's REST reference before shipping. Cap it to one call per import and skip it for hosts you have denylisted.

**9. Say what happened.** Add `via: 'direct' | 'reader' | 'unlocker' | 'archive' | 'google'` to `handleLink`'s response and show one line in the editor for `google` ("read as text; the site wouldn't let us fetch its photos") and for a `/url` fallback. This is the owner's own rule from `CLAUDE.md:20-26`, applied to the two paths that currently break it (F12).

**10. The phone route (largest change; Free-plan).** An iOS Shortcut ("Run JavaScript on Web Page") posts `{ token, url, jsonld, og, images, text }` to a new `/capture` route. Because the app is a PWA the Shortcut can't hand off into (`CLAUDE.md:657-661`), the Worker must stash the capture for the app to collect: a KV namespace (create it explicitly and commit the id — ids aren't secrets — which sidesteps the auto-provisioning objection in `CLAUDE.md:201-203`) or a SQLite Durable Object. The token is an HMAC the Worker mints for a signed-in member and Settings embeds in the Shortcut:

```ts
async function captureToken(uid: string, secret: string) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(uid)))
  return `${uid}.${btoa(String.fromCharCode(...mac)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')}`
}
// /capture: split on '.', recompute, timing-safe compare, then env.CAPTURES.put(`cap:${uid}:${id}`, body, { expirationTtl: 3600 })
// Add-a-recipe screen: GET /captures with the Firebase token → "1 page waiting" → the normal parse + Gemini + /img path.
```

Photos still flow through `/img` from the app, as the report advises.

Housekeeping to fold into any of the above: `[observability] enabled = true` in `wrangler.toml` (Workers Logs has a free allowance; check the current limits page), a current `compatibility_date`, a module-level JWKS cache keyed by `kid` wrapped in `try/catch`, a per-photo deadline in `attachLinkPhotos` so the editor opens within a bounded time, the entity decode in `recipeFromJsonLd`, and treating a timeout as `'refused'` rather than `'missing'` at `:638`.

## 5. Open questions for the author

1. In production `wrangler tail` output, do archive.org 429s show `retry-after 60s` or `not given` (`:480`), and does the *availability* lookup 429 as well as the replay? Whether the lookup survives while replay is refused decides whether the breaker should be per-surface.
2. For Serious Eats specifically, what does the `page direct:` line say: a `403`, or `no recipe data (bot challenge)`, or `no recipe data, N chars` with a large N? The last means a 200 challenge or consent body is reaching the fallback path (F5).
3. Is `import-recipe.yml` used at all any more, or can it be removed with the retired sync?
4. Has `gemini 400 … retrying without schema` (`:1169`) ever appeared in the tail, and if so did that import validate or fail in `sanitizeAiRecipe`?
5. Have you seen "Worker exceeded CPU time limit" (error 1102) entries, and for which hosts? That tells us whether F6 is a present failure or only a ceiling.
