# Curated Kitchen

A recipe log, live cooking helper, and shared grocery list, built as an
installable PWA (React + TypeScript + Vite + Firebase) so it runs on iPhone
without an Apple developer account. Used by a couple and a few friends — not a
public product.

## Working with the owner (read this first)

The owner is comfortable pushing changes from a phone by chatting, but is **not
a web developer**. Two obligations follow:

- **Always call out manual steps.** When a change needs the owner to do
  something outside the code — re-publish Firestore rules, add a GitHub secret
  or variable, change a Pages/Firebase console setting, reinstall the PWA —
  say so explicitly at the end of the reply, with the exact clicks. Never
  assume a config or console step happened on its own.
- **Explain the "why" briefly, in plain terms.** A one-line reason beats a
  wall of jargon.
- **Design for the friends, not the developer.** Friends using the app aren't
  technical, and the owner won't always be around to fix things. Anything
  that can go wrong for them must heal itself (retry, renew, fall back to an
  equal-quality route) or fail with a plain message and a clear next step —
  never rely on the owner running a command to keep it working, and never
  silently hand them a lower-quality result (e.g. an import without its
  photos). Owner-only setup is fine as a one-time step.

## Deploy tracks (the #1 source of "it didn't work")

Different things ship on different tracks. Mixing them up is the most common
confusion:

- **App code → automatic.** Every push to the working branch runs
  `.github/workflows/deploy.yml` (typecheck → validate recipes → build →
  GitHub Pages). ~2 min, push to live. Nothing manual.
- **`firestore.rules` → MANUAL.** Rules do **not** deploy with the app. After
  any commit that changes `firestore.rules`, the owner must re-publish them:
  **Firebase console → Firestore Database → Rules → paste → Publish** (or
  `npm run deploy:rules` from a computer). **Whenever a change touches
  `firestore.rules`, tell the owner to re-publish, every time.**
- **Step photos → live in Firestore now (NO Storage, no billing).** Step photos
  are compressed in-browser to JPEG data URLs and stored as documents in the
  `photos` Firestore collection (`src/data/photos.ts`) — `Step.images` holds the
  photo doc ids. This is the ConsoliDated approach, and it's deliberate: enabling
  Firebase **Storage** now requires attaching a **billing account (Blaze plan)**,
  which the owner doesn't want; Firestore stays on the free Spark plan. So there
  is **no `storage.rules` and no Storage to enable** — the `photos` collection is
  gated by `firestore.rules` (members write, members + guests read), and its
  allow/deny cases are covered by `npm run test:rules` like every other
  collection. The only manual step is the usual one: **whenever `firestore.rules`
  changes, re-publish it** (see above). Trade-off: each photo must fit in a
  Firestore doc (~1 MB), so `compressToDataUrl` downscales + drops quality until
  it fits; copies duplicate the photo docs into the new kitchen, so they're fully
  independent (removing a photo from one recipe never touches another).
- **Recipe content → authored in the app now (repo sync RETIRED).** Recipes are
  created, edited, copied, and deleted **inside the app** (`RecipeEditor` →
  `origin: 'app'` docs). The old repo→Firestore sync — where `recipes/*.json`
  was authoritative and pushed to Firestore on every commit — is retired,
  because a live sync would clobber in-app edits by slug on each push. The
  `recipes/*.json` files are kept only as a **frozen archive/backup**, and
  `.github/workflows/sync-recipes.yml` no longer runs on push: it's now
  **manual-only** ("Restore recipes from archive"), runs **without `--prune`**,
  and is for disaster recovery — running it re-seeds from the archive and would
  overwrite in-app edits to any recipe whose slug matches an archived file, so
  reach for it only to recover a lost kitchen. (Follow-up idea if a live backup
  is wanted: reverse the direction — a scheduled Firestore→`recipes/*.json`
  snapshot that never overwrites live edits.) Editing a recipe in the app marks
  it `origin: 'app'`; deleting one is now permanent (nothing re-creates it).
- **Recipe backup → automatic (owner-only).** `.github/workflows/backup-recipes.yml`
  (`scripts/backup-recipes.ts`) is the safety net now that the app owns recipes:
  it snapshots the `KITCHEN_HOUSEHOLD_ID` household's recipes from Firestore into
  `backups/recipes/*.json` (weekly + manual) and commits them with `[skip ci]`.
  Owner-only by construction — it runs in CI with the repo's service-account
  secret, never in the app, so members can't reach it. It's **additive** (never
  deletes, so an empty read can't wipe the archive; deleted recipes live on in
  git history). Restore is manual, for disaster recovery:
  `npm run backup:recipes -- --household=<id> --restore`. NOTE: GitHub runs the
  weekly `schedule` only from the default branch, so it kicks in once this is on
  main; run it by hand from the Actions tab any time. It reuses the existing
  `FIREBASE_SERVICE_ACCOUNT` secret + `KITCHEN_HOUSEHOLD_ID` variable — no new
  setup.
- **Recipe import Worker → MANUAL (Cloudflare, one-time).** The `worker/`
  Cloudflare Worker powers "Add a recipe" imports and has **two routes**:
  - **`/url` (FREE) — paste a link.** The app can't fetch another site directly
    (browser CORS), so the Worker fetches the page server-side and returns the
    schema.org **JSON-LD** most recipe sites embed; the app converts it with the
    same pure `recipeFromJsonLd` (`src/lib/importRecipe.ts`) and validates with
    `parseRecipe` → editable preview → save as `origin: 'app'`. **No API key** —
    reading structured data is deterministic. Fragile per-site (bot walls / no
    JSON-LD), so it degrades to paste/photo; that's expected. Most big sites
    (Serious Eats, Smitten Kitchen, …) block this fetch, so with AI enabled it's
    now only the **fallback** for "Add from URL" — see the AI route's `{ url }`.
  - **root (FREE with Gemini) — paste text or a photo → AI.** Uses Google
    Gemini's **free tier** (an AI Studio key with no billing) by default —
    `GEMINI_API_KEY`, a Worker secret, never in the public app; `GEMINI_MODEL`
    overrides the model. Default is `gemini-3.5-flash-lite` with a fallback to
    `gemini-3.5-flash`: on the free tier the fuller flash models are heavily
    contended (sustained 503s, and sometimes they hang until a Cloudflare 524),
    while `-lite` reliably has capacity and is plenty for structured extraction.
    The answer is **streamed** (`streamGenerateContent?alt=sse`, v0.48) so a
    slow model and a stuck one look different: a model gets 20 s to start
    answering (30 s when Google must first fetch a link or look at photos),
    then 15 s of silence mid-answer, and 90 s in all — a model that's writing
    keeps its time. The fixed 30 s cut-off it replaced stopped a real Serious
    Eats import whose answer needed ~31 s (the retry succeeded in ~28 s) — on
    the free tier, `-lite` writes a long recipe (full step text + cook-mode
    `brief` + structured ingredients) in 10–30 s depending on load. The
    pieces (`data: {…}` events) are joined; an answer with no end marker
    (`finishReason`) is kept only if it's complete JSON. The Recipe node sent
    to the AI (`pageForAi`) drops `review`/`comment`/`aggregateRating`/`video`/
    `publisher`/… first. A **503 from the light model gets one
    more try after 1.5 s** (on the free tier "overloaded" comes and goes by the
    second, and Google advises retrying; the same log showed `-lite` 503 then
    the fuller model hanging); other 5xx, a 429 (quotas are per model), a hang
    or a 404 skip to the next model, and a 400 retries that model once without
    the responseSchema (the app's zod schema is the real validator). No `thinkingConfig` — the `-lite` tier 400s on it. Pinning
    `GEMINI_MODEL` forces one model with no fallback (e.g. `gemini-3.6-flash`
    once it settles). A retired id shows up as a 404 "no longer available." It reads any layout (blog-style pages the
    `/url` route can't) and photos/screenshots — the app posts `{ images: [...] }`
    (one or several photos of the SAME recipe, read together; the legacy single
    `{ image }` is still accepted). **A link** (`{ url }`, Add a recipe → **Add from
    URL**, first in the chooser) is read by Gemini itself via its
    **URL-context tool** (`tools: [{ url_context: {} }]`, combined with the same
    structured output): Google serves the page from its own search index first,
    so small sites come through (paywalled pages don't). The Worker only trusts
    the answer if `urlContextMetadata` reports `URL_RETRIEVAL_STATUS_SUCCESS` —
    otherwise the model may recite a recipe from memory; missing metadata is let
    through and logged. **Serious Eats (Dotdash Meredith) blocks Google's AI
    reader too** (`URL_RETRIEVAL_STATUS_ERROR`), so on a failed retrieval the
    Worker gets the page itself via `fetchRecipePage` — direct fetch (8 s budget;
    if it hasn't answered in 3 s, **Jina Reader** starts alongside and the first
    recipe wins, the other called off) → **Jina Reader** (`r.jina.ai`, free, no
    key, ~20 req/min; renders in a real browser; 12 s) → **Firecrawl and the
    Internet Archive side by side** (v0.47; `firstTrue` — the first to bring a
    recipe wins). **Firecrawl** (`FIRECRAWL_API_KEY`, optional Worker secret;
    free plan, no card, 1,000 credits/month, 1 credit per page or photo — its
    docs say the `enhanced` proxy costs the same, some reviews say 5) fetches
    from its own servers via `POST api.firecrawl.dev/v2/scrape` with
    `formats: ['rawHtml']`, `proxy: 'auto'` (plain proxies, then ones that look
    like ordinary visitors), `parsers: []` (never bill a PDF by page), 25 s. It
    runs only when no page so far showed any sign of a recipe (signal ≤ 0 —
    a page that did is the real page) and pauses itself (`pauseUnlocker`,
    module memory): 402 out of credits → 6 h, 429 (free: 10/min) → 1 min,
    401/403 bad key → 1 h, logged `firecrawl: …`; the import carries on
    through the Archive meanwhile. The diagnostics line ends `firecrawl on (N
    credits left until …)` (`/v2/team/credit-usage`, once per Worker copy) /
    `paused (…)` / `off (not set up)`. A Firecrawl page (`via: 'unlocker'`)
    takes the Archive lookup's timestamp as its `stamp`, so its photos can
    still come from the Archive's copies through wsrv.nl (Serious Eats' own
    image host refuses the Worker and wsrv.nl alike: in real logs photos only
    ever came via `proxy/archive`, 12 of 20, the rest failed); `photos.unlocker:
    true` tells the app the Worker can fetch a photo through Firecrawl, and
    after every free candidate for a photo failed the app asks `/img` once with
    `paid: true` for its best size (`unlockPhoto`: `formats: ['rawBase64']`,
    Firecrawl's JSON streamed straight through — decoding base64 would blow the
    free plan's CPU — and decoded in the app, `fileFromUnlocker`; the photo
    deadline is 22 s when Firecrawl is available). The key goes only to
    api.firecrawl.dev. The owner chose Firecrawl knowing sites that block
    automated reading (Serious Eats) likely forbid it in their terms — it's for
    a household's occasional imports, one page at a time. The **Internet
    Archive's** latest saved copy (`archive.org/wayback/available`
    → `web.archive.org/web/<ts>id_/<url>`; that quick lookup sometimes says "no
    copy" for pages saved many times — a years-old Serious Eats recipe, twice —
    so when it's empty the Worker asks for **the save closest to right now**
    (`/web/<now>id_/<url>`: the Archive redirects to its latest save, and the
    final address — `FetchInfo.url` — says which; one request, no lookup API).
    Only when the copy it got isn't a usable recipe page does `archiveCaptures`
    ask the full **CDX index** for older saves (tries up to two it hasn't read):
    `fl=timestamp,statuscode,mimetype&fastLatest=true&limit=-10`, the Archive's
    documented shape, filtered to 200/HTML in our code — asking the live index
    to `filter=` got a **400** (v0.42.3). A 400 anywhere logs the server's
    reason (`page …: 400 says "…"`). Lookups use `archiveKey(url)`, the link
    minus `#fragment` and `utm_`/`fbclid`-style tracking params). Pages are scored
    by `recipeSignal` (v0.46): 3 = schema.org Recipe data, 2 = recipe-plugin
    markup (`wprm-recipe`, `tasty-recipes`, microdata) or an Ingredients heading,
    1 = mentions ingredients, 0 = none, -1 = a bot challenge (HUMAN "Press &
    Hold", DataDome, Incapsula… — checked only when there's no recipe markup,
    since real pages load captcha scripts too) or a near-empty page. A score of
    2+ ends the search (a plugin page no longer burns Jina and Archive
    requests); otherwise the highest-scoring page any route brought is kept
    (not the first). `findRecipe` / the app's `findRecipeNode` also look in
    `WebPage.mainEntity` and match `@type` in any case or as a list; the app's
    `recipeFromJsonLd` decodes `&frac12;`-style codes and splits a one-string
    instruction on paragraphs/lines. It then has Gemini read `pageForAi` (the JSON-LD + visible page text) as a normal
    text import. Every step logs `page <route>: …` in `wrangler tail`. Only if
    all fail does it return 422 "Couldn't open that page" (or "paywall"). The
    `/url` JSON-LD route uses the same chain. The app sets `source.url` to the
    pasted link. With AI on, the app no longer falls back to the `/url` route
    (it re-ran the whole search, then imported a lesser version silently):
    when Gemini fails after the Worker got the page, the Worker answers
    `code: 'ai_busy'` and the app shows "Couldn't finish reading this recipe —
    the recipe reader we use (Google's AI) is overloaded" with just **Try
    again** (unlocked after 5 s). 0.46–0.47 also offered "Import it as listed"
    (the site's recipe data without the AI: steps as written, no cook-mode
    bullets, aisles guessed) — removed in v0.48 at the owner's call: the
    difference isn't something a friend can judge, and imports should come out
    the same every time. A page that shows no
    recipe signs and that the AI calls `not_a_recipe` (likely a soft block)
    goes to Google's reader instead. The recipe URL is sent to
    Jina / archive.org (public links, no user data). **Order (v0.39):** `handleLink` now
    gets the page itself FIRST (direct → Jina → Archive) and has Gemini read it
    as text; Google's URL-context reader is only the last resort (no page from
    any route). That's so a link import also brings the **page's photos**:
    `findLinkPhotos` reads the cover from the recipe data's `image` / `og:image`
    and each HowToStep's `image` (≤3 per step, ≤10 total), and the response
    carries **links only** — `photos: { cover, covers, steps: {index: urls},
    stamp }`. **The cover is a few candidates** (`covers`, ≤4, best first;
    `cover` = the first, for older apps): recipe data often names a big size of
    the main photo the page never shows, and the Archive only saves images a
    page shows, so `findLinkPhotos` (via `pageImageIndex`) adds every size of that photo the page's
    own `<img>`/`<source>` src/srcset/data-src shows (matched by `photoStem`: file
    name minus extension and `-1024x683`-style suffix), widest first — and puts
    them FIRST for an Archive-read page (listed sizes first otherwise). The app
    tries them in turn until one downloads and decodes. **Step photos get the
    same treatment** (v0.42.2 — a cacio e pepe import got its cover but none of
    its step photos, each of which had only its one recipe-data link, a size
    the Archive never saved): `stepCandidates: {index: [[sizes…], …]}` (≤3
    sizes per photo), from one pass over the page (`pageImageIndex`, photos
    grouped by stem — the free plan's ~10 ms CPU can't rescan the page per
    photo). `steps` (each photo's first link) stays for older apps. Step photos are attached only when the AI kept the page's step
    count (the SYSTEM prompt now says keep step boundaries); otherwise just the
    cover. The app downloads each through **`POST /img`** (`handleImageProxy`:
    streams an image straight through, never buffers — the free plan's ~10 ms CPU
    budget can't base64 megabytes; tries the image from the site, then — when
    the page came from the Archive — the Archive's `im_` copy **through
    wsrv.nl** (a free public image proxy, no key; it fetches from its own
    servers). We ask the Archive directly only if wsrv.nl itself is down
    (timeout / 5xx), never when it answered 4xx ("not saved"): our own Archive
    requests come from Cloudflare's shared addresses, which the Archive rations,
    and a photo-heavy import (up to ~14 Archive requests with the old per-photo
    retries) spent that allowance before the next import's *page* could get
    through (v0.42). Finally wsrv.nl for the site's image; 15 s cap per route
    for headers;
    images only, private hosts refused;
    logs ONE line per photo, `img ok|failed [site 403 → archive 429 → … ]
    host/…end-of-path`), compresses them like any added photo, and opens the preview editor
    with them as unsaved photos, so saving stores them as photo docs.
    **Every request identifies us honestly** (`APP_UA`, "CuratedKitchen/1.0
    (+https://cwang427.github.io/curated-kitchen/; …)", in `SITE_HEADERS`) —
    the Archive since v0.42.4, and sites, Jina and `/img` since v0.46 (the
    Chrome-125 `BROWSER_HEADERS` is gone): a Worker's connection looks nothing
    like a browser's, and a browser name on it is exactly what bot filters
    score as spoofing. It won't get past a site that blocks automated fetches
    (nothing from a Worker does); a site that refuses the honest name still
    comes through Jina and the image proxy, just slower — watch the `import`
    log lines for sites that stop working directly. **Serious Eats let the
    honest name in** (first 0.47 log: `page direct: 200`, recipe data, after
    17 of 17 refusals of the Chrome disguise) — one data point, but what the
    research predicted: the disguise itself scored as a bot. The
    same update says **signed-in users don't get 429s**, so the Worker
    **signs in — and keeps itself signed in** (v0.44; the owner can't be on
    call to fix an expired sign-in for friends). Secrets, all set at once by
    `npm run archive:login` (`scripts/archive-login.mjs`, plain Node, no
    install; it checks the account by signing in the way the Archive's `ia`
    tool does — POST `archive.org/services/xauthn/?op=login` → `values.cookies`
    — then `wrangler secret bulk`s): `ARCHIVE_SESSION` = `{cookie, expires}`
    (the two session cookies `logged-in-user` / `logged-in-sig`, and their own
    expiry — a year), `ARCHIVE_EMAIL` / `ARCHIVE_PASSWORD` (an Archive account
    made just for the app). `currentArchiveSession()` uses this Worker copy's
    session, else the saved one, and **signs in again a day before it
    expires** — by the date only (v0.45): 0.44 also signed in again and retried
    when the Archive refused a signed-in request, but a sign-in minutes old was
    refused just the same, so that only cost another request. **Signing in did
    not stop the 429s** (a fresh sign-in was refused at once, from the same
    outgoing address that succeeded minutes earlier); it's kept since it costs
    nothing and may count for something. A
    failed sign-in waits 10 min before the next try and imports carry on
    unsigned (logged `archive sign-in: failed (…)`). The session lives in module
    memory (a new Worker copy starts from the saved one; no KV — auto-provisioned
    KV would write its id into the owner's local wrangler.toml and snag the next
    pull). The cookie is sent **only to archive.org / web.archive.org**
    (`archiveHeaders()`, async); the password only to the sign-in endpoint.
    0.43's cookie-only `ARCHIVE_COOKIES` is still honored. The diagnostics line
    ends `archive sign-in on (saved, until …)` / `on (signed in automatically)`
    / `off (not set up)` / `off (signing in failed …)` / `ready (not needed this
    time)`.
    **The Archive throttles (429)** the shared addresses Workers fetch from —
    by source address (IA staff: ~60/min for the CDX index, with a 1-hour
    block that doubles if 429s are ignored); signing in and an honest name
    don't change which counter we hit. Nothing is retried (`fetchText` has no
    retry loop since v0.46; it logs each 429's `Retry-After` — in real logs
    always `not given` — and whether it carries `memento-datetime`). **A
    breaker** (v0.46, `noteReplay` / `replayWaitMs`, module memory, per Worker
    copy) covers **web.archive.org only** (page copies + the CDX index): a
    429/503 without `memento-datetime` (with it, it's a saved copy of the
    SITE's own 429 — not a refusal) or a copy that doesn't answer in 12 s opens
    it for 90 s, doubling on each refusal in a row to a 10-minute cap, jittered;
    while open, no request goes to web.archive.org at all (`page archive …:
    skipped`). Any answer closes it and logs `archive breaker: answered again
    Ns after the first refusal` — the data for tuning the cap (real logs showed
    refused copies working minutes later; the 1-hour figures are about CDX).
    The availability lookup (archive.org, a different host) never refused us
    in 17 of 17 logged imports and still runs while the breaker is open. The
    research behind all this is in `docs/research/` (read `HANDOFF.md`'s
    "Revised after review" first). **Diagnostics:** each link import logs
    `link: ran in <colo>, worker copy <id> (import #N since it started M min
    ago), outgoing address <ip> (outside Cloudflare's view), archive sign-in …,
    firecrawl …, worker <version>` — the address from `checkip.amazonaws.com`
    or `ifconfig.me`, whichever answers first (once per Worker copy; the first
    alone came back empty once). It must be a service NOT on Cloudflare (an
    answer of `2a06:98c0:3600…` is rejected): ipify is, and Cloudflare shows every Worker's requests to its
    own customers as `2a06:98c0:3600::103` — the "shared egress" address in the
    research and everything 0.43–0.47 logged was that label, not an address
    the Archive (not on Cloudflare) ever sees. `worker <version>` is
    `package.json`'s version bundled in by wrangler, so the tail shows which
    Worker is deployed. And one structured
    `{ event: 'import', host, via, status, ms, archive, cover, stepPhotos }`
    line per import. **Workers Logs** is on (`[observability]` in
    `wrangler.toml`, free plan: 3 days), so these can be filtered afterwards in
    the Cloudflare dashboard (Workers & Pages → curated-kitchen-import → Logs),
    not only while `wrangler tail` runs. `REFUSING_SITES` (NYT Cooking) answers
    at once with `code: 'site_refuses'` and what to do instead.
    Other sources were weighed and rejected: the "Wayback Machine" IS the
    Archive; archive.today (CAPTCHA loops, blocks Cloudflare-related traffic,
    blacklisted by Wikipedia in Feb 2026 after being used for a DDoS and
    altering snapshots; only has pages people saved); Common Crawl (built for
    programmatic use, but monthly, no photos, and CCBot is one of the
    most-blocked crawlers); Google/Bing caches are gone.
    If the copy is refused, Jina Reader fetches the Archive's copy for us
    (`r.jina.ai/<archive url>`) — unless Jina already refused the site (451):
    it refuses any link naming a site that blocks it, Archive links included
    (Serious Eats: 5 of 5 in real logs), so that request is skipped.
    **When no route got the page** (`readWithGoogle`, v0.46), Google's reader
    reads it from Google's servers — the recipe, but **not its photos**
    (without the page we can't find them). When the Archive has a copy it
    refused us (`PageLookup.archiveCopy` + `archiveBusy`) and Jina refused the
    site, Google reads **the Archive's copy** (it fetches from its own
    addresses; the v0.41.7 idea) instead of the site; otherwise the site, then
    the copy. The answer carries **`photosUnavailable: true`** and, when the
    Archive was only busy, **`retryAfterMs`** (the breaker's wait, at least a
    minute). If nothing could be read while the Archive was busy: 422 "<site>
    blocks direct imports, and its saved copy at the Internet Archive is busy
    right now." with **`code: 'archive_busy'`** + `retryAfterMs` (a paywall or
    a genuinely missing copy keeps its own message). **The app never retries by
    itself** (v0.46; 0.45's 40/50/60 s countdown re-ran the whole search each
    time and held friends for minutes with no idea how it would end). The
    owner's rule for anything less than a full import: **the cook chooses**
    (`ChoicePanel` in `AddRecipePage`): recipe but no photos while the Archive
    is busy → "We could read the recipe, but not its photos" with **Continue
    without photos** / **Try again** (locked with the time left — "Try again in
    1:30" — until `retryAfterMs` passes); no photos and nothing to wait for →
    straight to the editor with a note; every photo download failed → the same
    choice, Try again open at once; nothing readable while busy → **Paste the
    recipe text instead** / Try again. Paste is offered only when there's no
    text to be had — otherwise it's the same text with more work. Anything the
    import couldn't bring shows as a note above the preview editor (right by
    the cover-photo button). With Firecrawl set up these choices become rare
    (it usually brings the page and its photos). `isArchiveBusy` / `busyRetryMs`
    (`src/lib/archiveBusy.ts`) also read a Worker older than 0.45. `/img` falls back to wsrv.nl (above), and the app downloads photos **three at a time** (v0.42.1; it was
    one at a time for Archive pages while photos still hit the Archive from our
    shared addresses — through wsrv.nl there's no allowance of ours to spend),
    each into its fixed slot so a step's photos keep their order — within
    **15 s in all** (v0.46, `PHOTO_DEADLINE_MS`; ≤12 s per photo): the editor
    then opens with whatever arrived and says "3 of 5 photos came through"
    (`LinkReport.photos`), rather than a slow image host holding the import.
    `/img` caps a response with no declared size at 12 MB as it streams. The
    Worker checks the caller's sign-in against Google's keys cached for 6 h;
    if Google's key server is unreachable it answers 503 "try again" (with
    CORS) instead of crashing. An Archive copy
    can predate the site's latest edit — it's a fallback, not the source. **PDFs ride the same `images` array** with
    `mediaType: 'application/pdf'` — the Worker passes each file's type straight
    through as Gemini `inline_data`, and Gemini reads PDFs natively (scanned
    pages too), so PDF import needed no Worker change. The app sends a PDF as-is
    (`readFileBase64`, no downscale), capped at 10 MB each / ~13 MB per request
    (Gemini's inline limit is far higher). The dormant Claude route would need a
    `document` block for PDFs — it sends everything as `image`. Then → tidied by
    `sanitizeAiRecipe` (`src/lib/aiRecipe.ts`: a missing yield becomes "1
    batch", `{{½ cup}}` → `{{1/2 cup}}`, half-filled timers/temps and bad links
    are dropped, so one model slip can't sink a good import) → the same
    `parseRecipe` → editable preview → save.
    When AI is enabled it's the **default engine for text** (the on-device
    `importText` parser is the offline/rate-limit fallback) and the **only
    engine for photos**. A paid Anthropic Claude route (`ANTHROPIC_API_KEY`,
    forced `save_recipe` tool) is kept as an alternative — the Worker uses it
    only when no Gemini key is set. Off in the app until `AI_IMPORT_ENABLED = true`.

  Deploy once (`worker/README.md`); URL import needs only `FIREBASE_PROJECT_ID`.
  Put the Worker URL in `src/lib/aiConfig.ts` (`IMPORT_WORKER_URL`; not secret,
  empty until set → the options that need it stay hidden). The Worker verifies
  the caller's Firebase ID token (members only) and guards its fetcher against
  private/loopback hosts (basic SSRF). No `firestore.rules` change. The
  Worker's code is `worker/src/importer.ts` (`worker/src/index.ts` is just the
  entry that exports it, so tests can import the pieces); `wrangler` builds it —
  and bundles in `src/lib/tags.ts` (the fixed tag list), so keep that file free
  of React/DOM and other app imports. `worker/tsconfig.json` makes
  `npm run typecheck` (and CI) type-check the Worker and its tests too.

  **Redeploying the Worker ships from LOCAL files, not GitHub** (unlike the app,
  which CI always builds from the pushed branch). So after ANY commit that
  changes `worker/`, tell the owner to update their computer's copy *before*
  `wrangler deploy` — `git checkout <working branch> && git pull`, then
  `cd worker && npx wrangler deploy` — otherwise a stale local copy silently
  redeploys the old behavior and it looks like the change "didn't work." When a
  Worker-code change is what shipped, this pull-then-deploy is the manual step to
  spell out, every time.

## The core bet: ingredients are structured data

Everything good falls out of the `Ingredient` shape in `src/lib/types.ts`
(quantity, unit, item, `canonical`, `category`, `scalable`, `alt`). Scaling,
grocery aggregation, and step↔ingredient links all depend on it; free-text
ingredients would break all three. `src/lib/` (types, units, quantity,
recipeSchema) is the heart of the app and has no React/DOM dependency, so it
also runs under Node in the scripts.

Rules of thumb, already enforced — keep them:
- Combine quantities only **within** a dimension (mass/volume/count). Never
  convert volume↔mass (needs density); the code refuses rather than guess.
- Scaled amounts snap to cook-friendly fractions and only promote units
  (`6 tsp`→`2 tbsp`) when the conversion is exact.
- Parenthetical measurements are structured (`alt`) so they scale; amounts in
  step prose scale via `{{ }}` tokens. Times/temperatures stay plain text.
- Every recipe has `schemaVersion`; bump it and migrate deliberately.
- A step may carry an optional `brief`: a concise, one-action-per-line version
  shown in **cook mode** (the recipe reader always shows the full `text`). When
  `brief` is absent, cook mode auto-splits `text` into sentence bullets. `brief`
  lines may carry `{{ }}` tokens so amounts still scale. Never let a meaningful
  instruction live only in `brief` — `text` stays the complete original prose.

## Sharing model

A **household** is the unit of trust. Members (the couple) read/write
everything. **Recipes are shared with guests (friends) by default** —
`visibility` defaults to `'friends'`, and the editor's "Who can see it" offers
two states: *Everyone in this kitchen* (`'friends'`) or *Members only*
(`'household'`, the hide option; legacy `'private'` is treated as members-only).
Guests never see the grocery list, meal plan, or cook session. Rules key on
`request.auth.uid`, never the email or provider. Joining is by invite link
(`src/data/invites.ts`, Settings screen).

What a guest can do with a shared recipe: **view, cook (solo), copy it into
their own kitchen, and add its ingredients to their own grocery list** — but
**not edit it in place** (Edit/Delete stay members-only), and not touch the
kitchen's own list/plan/session. This needed **no rules change**: copy creates a
recipe in a kitchen the guest is a *member* of, and add-to-list writes that
*member* kitchen's list — both already allowed. `copyRecipeToHousehold` and
`AddToListSheet` therefore target one of the guest's own kitchens (a picker when
they have several), never the kitchen they're visiting.

A guest's reads must still be **scoped in the client**: a friend may only list
recipes filtered to `visibility == 'friends'` (Firestore refuses an unfiltered
household listing for them — it could return docs they can't read), so
`useRecipes(id, nonce, friendsOnly)` adds that filter for non-members. The
grocery/plan/session subscriptions and the members-only UI (header cart/plan,
add-to-plan, cook-together, Edit/Delete) are hidden for guests — a member-only
read would just permission-deny. `test:rules` locks in the member-lists-all /
friend-lists-only-friends behavior. Recipes created before share-by-default are
brought in with one tap: **Settings › Guests › "Make N hidden recipes visible
to guests"** (`shareRecipesWithGuests`, a member batch write).

Role management is **owner-gated**: only the household **owner** (its creator)
can remove or demote a member or promote a friend; **either member** can remove
a read-only friend; **anyone but the owner** can leave on their own. The owner
can never be removed or demoted (they must stay in `memberUids`), and ownership
isn't transferable yet. These live in `src/data/household.ts` and the
`households` update rule; change them together and re-run `npm run test:rules`.

A user can belong to several kitchens (`UserProfile.householdIds`), with one
**active** at a time (`defaultHouseholdId`). The Settings "Your kitchens"
switcher (`fetchHouseholds` / `switchHousehold` / `createHousehold` in
`src/data/household.ts`) flips between them and starts new ones; everyone gets a
personal kitchen on first sign-in. A kitchen with only you reads as "Personal",
otherwise "Shared" — a derived label, not a stored field. Switching just
repoints `defaultHouseholdId`, and every screen re-subscribes to the active
household, so no rules change was needed for it.

Redemption is security-sensitive: a rule can read documents but not client
variables or query filters, so the joiner **stages the invite code on their own
user doc** first; the household rule then `get()`s that doc, looks up the
invite, and allows a single-element self-add only if it names this exact
household and role. If you change the join flow, change the rules and the
client together, and re-run the rules test.

## Auth

Email/password (not Google — its cross-domain redirect breaks in an installed
iOS PWA). Accounts are created in the Firebase console; there is no in-app
sign-up. `firebaseConfig.ts` is committed on purpose — those values aren't
secret; `firestore.rules` is the security boundary.

## Versioning

`__BUILD__` (version + git commit + time) is injected by Vite's `define` and
shown in Settings; the build also writes `dist/version.json`, which the app
fetches (no-store) to tell the owner if a newer deploy is live. `version.json`
must stay out of the Workbox precache glob so it's always fetched fresh.

The git commit + build time advance automatically every deploy (that's what
the "up to date / update available" check compares). The human-readable
`version` in `package.json` does **not** — bump it by hand when shipping a
feature so the number reflects reality: `npm version <x.y.z> --no-git-tag-version`
(updates both package.json and the lockfile; no git tag). Convention: minor
bump (0.x.0) per shipped feature, patch (0.x.y) for fixes.

## Verifying changes (do this before pushing)

- `npm run typecheck` — always.
- `npm run validate:recipes` — after any recipe or schema change.
- `npm run test:worker` — after any `worker/` change: the link route against a
  fake internet (`scripts/test-worker.ts`) — which routes it asks, how many
  Archive requests, the breaker, the honest name, Google reading the Archive
  copy, `ai_busy`, the sign-in renewal, the image-size cap, and Firecrawl (when
  it's asked, what for, racing the Archive, pausing on 402/429/401, the paid
  photo route).
- `npm run test:rules` — after any `firestore.rules` change. Runs ~70
  allow/deny assertions against the Firestore emulator (needs Java; first run
  downloads the CLI + emulator), including the `photos` collection (members
  write, members + guests read).
- `npm run test:import` / `npm run test:text` / `npm run test:grocery` /
  `npm run test:plan` / `npm run test:steps` / `npm run test:draft` /
  `npm run test:cook` / `npm run test:ai` / `npm run test:units` /
  `npm run test:tags` — pure-logic unit tests for the JSON-LD converter, the
  free pasted-text importer (real full-page fixtures under
  `scripts/fixtures/text/`), the grocery merge/aisle logic, the meal-plan day
  window + plan→groceries aggregation, the cook-mode sentence splitter, the
  recipe editor's draft↔schema round-trip, and the "cooking now" multi-dish
  timeline (attention/agenda merge + ordering), the AI-answer tidy-up
  (`sanitizeAiRecipe`), unit/item pluralization ("bay leaf" → "bay leaves",
  never "leafs"/"leaveses"), and the fixed tag list's normalizing
  ("Main Course" → mains, "roman" → italian, "beef" dropped). Run after touching
  `src/lib/importRecipe.ts`, `src/lib/importText.ts`, `src/lib/grocery.ts`,
  `src/lib/plan.ts`, `src/lib/quantity.ts`, `src/lib/recipeDraft.ts`,
  `src/lib/cookboard.ts`, `src/lib/aiRecipe.ts`, `src/lib/units.ts`, or
  `src/lib/tags.ts`.
- `npm run ui` / `npm run ui:build` — renders real pages against fixtures with
  Firebase stubbed (`.preview/stubs/`), for visual checks without credentials.
  Screenshot at phone width (393×852) and confirm no horizontal overflow,
  light and dark.

CI re-runs typecheck + validate + build on every push, so a red build blocks
the deploy and leaves the previous version up.

## Conventions

- Match the surrounding code's style; comments explain *why*, not *what*.
- Keep touch targets generous and type large — this is used at arm's length
  with wet hands. Palette is CSS tokens on `:root` with a dark-mode block.
- Keep anything that sits at the top edge **opaque** (no `bg-paper/90` +
  `backdrop-blur` on sticky headers), and put top-edge content under
  `.pad-safe-top`. iOS 26+ (much stronger in iOS 27) draws a "Liquid Glass"
  progressive blur over the top ~40pt below the status bar of an installed web
  app — system chrome, no CSS/meta switch. A solid-colour sampler strip did
  NOT stop it on iOS 27, so `.pad-safe-top` adds `--edge-clearance` (2.5rem,
  iOS standalone portrait only) to keep header content below the band; the band
  shows only the opaque header background, where blur is invisible. The other
  known fix — `apple-mobile-web-app-status-bar-style: default` — works too but
  only after every user deletes and re-adds the home-screen app, so we avoid it.
- **Back goes to a fixed parent screen, never "wherever you came from"**
  (`src/components/nav.tsx`): kitchen ← recipe ← cook mode / editor; kitchen ←
  Add a recipe ← its import screens (`/add?m=…`); kitchen ← grocery list / meal
  plan / cooking timeline / settings (`parentOf`). An installed iPhone web app's
  edge-swipe can't be disabled and always steps back one history entry, so the
  app keeps **browser history shaped exactly like the screen's ancestor chain**:
  every in-app link is `nav.tsx`'s `Link` / `goTo(path)` (never React Router's
  `<Link>` or a bare `navigate(path)`), which steps back to the deepest shared
  ancestor and pushes the rest — so a recipe opened from the meal plan sits
  directly on the kitchen. Every back / close / done control is `goUp()` (one
  history step = the parent). `HistoryChain` (mounted in `App`) rebuilds the
  chain underneath a screen opened directly (reload / link) and finishes goTo's
  two-phase moves. Add a recipe manages its own inner steps (the editor sits on
  its import screen so Back keeps the paste) and, on save, unwinds to the
  chooser and replaces it with the new recipe, so history reads kitchen → recipe.
- **Scroll is the app's, not the browser's** (`HistoryChain` in `nav.tsx`):
  `history.scrollRestoration = 'manual'`; a new screen opens at the top, going
  back restores that entry's saved position (retried per frame while content
  loads), then a 1px round-trip nudge forces a repaint. iOS's own restore on a
  history step landed mid-render (a recipe shows "Loading…" first) and left the
  page **blank until you scrolled** — tappable but unpainted — after Save
  changes. Also: **no `backdrop-blur` on sticky/fixed bars** (all opaque
  `bg-paper`), a classic WebKit paint-glitch trigger.
- **The `AppHeader` is sticky** (it stays at the top while you scroll, with its
  shortcuts). Never put `overflow-hidden` on a page's wrapper: it makes the
  wrapper a scroll box, and a sticky child then sticks to it instead of the
  screen — the kitchen's header scrolled away for exactly that reason (its
  pull-to-refresh wrapper). Use `overflow-clip`, which clips the same without
  becoming a scroll box. The header publishes its real height as
  `--app-header-h` (ResizeObserver; ~63px in a browser, ~150px as an installed
  iPhone app with the edge clearance), and anything that sticks just below it
  uses `top-[calc(var(--app-header-h,4rem)-1px)]` (the recipe page's scale
  bar — a fixed `top-16` slid it under the taller iPhone header).
- **No rubber-band bounce**: `overscroll-behavior-y: none` must be on `html` —
  iOS honours it only on the root and ignored the body's copy, so pulling past
  the bottom of a page bounced it and dragged the sticky header up off the
  screen with it. (The kitchen's pull-to-refresh is our own touch gesture.)
- Search fields are `SearchInput` (`src/components/SearchInput.tsx`): our own
  48pt ✕ at the right once there's text (the browser's is hidden in
  `index.css` — iOS shows none); it keeps the keyboard up if you were typing
  and doesn't summon it if you weren't.
- Never commit secrets. The service-account key lives only in the GitHub
  secret; `./secrets/` is gitignored.

## Roadmap

Done: sign-in, recipe reader + scaling, household/friend sharing by invite,
recipe sync CI, version stamp, cook mode (full-screen steps, wake lock,
cross-step timers, large controls, per-step mise-en-place checklist,
scannable step bullets — authored `brief` or auto-split prose, resume an
interrupted solo cook — several dishes at once — via the cook board
(`src/data/cookBoard.ts`) in localStorage),
pull-to-refresh, screen-name editor, recipe import (paste text; the old
GitHub Actions URL importer was removed in v0.46),
the shared grocery list (add-from-recipe, merge by canonical + unit, aisle
order, realtime check-off, quick-add), the meal plan (plan recipes onto a
rolling week → one-tap "add the week to groceries"), and two-phone "cook
together" sync (both phones follow the same step and timers via a shared
`sessions/{householdId}` doc), and member/role management (owner removes/
demotes members and promotes friends; either member manages guests; anyone but
the owner can leave), and a multi-kitchen switcher (belong to several kitchens,
switch the active one, create/name new ones — "Personal" vs "Shared" derived
from membership), and cross-kitchen recipe management (copy a recipe to another
kitchen you're a member of, delete a recipe with confirm; copies remember their
lineage via `copiedFrom` so the copy sheet flags "already copied" and confirms
before making a duplicate — copies stay independent forks, no live propagation),
and **share-with-guests-by-default** (recipes default to guest-visible; a member
can hide one via the editor; guests can view, cook, copy into their own kitchen,
and add ingredients to their own grocery list, but never edit in place or see the
kitchen's list/plan — no rules change, since copy/add-to-list act on the guest's
own kitchen; Settings › Guests one-taps pre-existing recipes into the default),
and recipe import from a link (Add a recipe → **Add from URL** →
the `worker/` `/url` route fetches the page → `recipeFromJsonLd` reads its
schema.org JSON-LD → validated by the same `parseRecipe` → editable preview →
save as `origin: 'app'`; free/no-key, degrades to paste/photo on sites that block
it or lack structured data), and AI recipe ingestion (paste text or a photo
→ AI via the same Worker — Google Gemini's **free** tier by default, off unless
enabled → structured → validated by the same `parseRecipe` → editable preview →
save as `origin: 'app'`; when enabled, the default engine for text with the
on-device parser as the offline/rate-limit fallback, and the only engine for
photos/screenshots — several at once, since a long recipe rarely fits one phone
screenshot, downscaled in-browser via `compressForImport` and combined into one
recipe — and recipe **PDFs** (Add a recipe → **Add from photo or PDF**; sent as-is
to Gemini, which reads them natively); a paid Claude route stays available as an
alternative). Photo/PDF import takes up to 12 files — our cap for upload size and
the Worker's 30s per-model wait, not Gemini's (which accepts far more); the
import screens carry no explainer text (the chooser's one-line subtitles do that
job). And
a full in-app recipe editor (`RecipeEditor` +
`src/lib/recipeDraft.ts`: edit overall details, the ingredient list, and each
step's text + cook-mode `brief`; start from scratch, edit an ingestion result
before saving, or **edit an existing recipe in place** at `/r/:slug/edit`
(`EditRecipePage` → `updateRecipe`, same slug/URL, becomes `origin: 'app'`) —
draft↔schema round-trip validated by the same `parseRecipe`; recipe authoring is
now fully in-app and the repo→Firestore sync is retired to a manual archive
restore, see Deploy tracks),
and a **live cooking timeline** (`/cooking`, `src/routes/CookingPage.tsx`) that
coordinates several dishes at once from the local cook board: a glanceable strip
of each dish's running timers plus a merged, time-sorted "Up next" list of what
needs you now (a rung timer or a dish with nothing counting down) and when each
timer will ring — pure merge logic in `src/lib/cookboard.ts` (`buildTimeline`).
It reads only real data (step position + `endsAt` timers), so it needs no schema
or rules change; a back-timed "ready by 6:45" scheduler (needing per-step
durations) is a deliberate later phase.
And **in-recipe multitasking** (cook mode's "Meanwhile", `src/routes/CookPage.tsx`):
when a timer you started belongs to a step you've moved on from, it shows in a
**Meanwhile band** above the current step — named by its step ("Meanwhile · Step
3"), counting down, tap to jump back; when it rings the band turns into a
prominent "← Back to step N" (and still beeps). Timers already persisted across
steps (they're dish-level, keyed by `source = "<stepId>:<label>"`); this just
partitions them into current-step (full-control tray) vs. away (the bands, via
`stepIndexForSource`), and adds a footer **work-ahead nudge** shown while the
current step is cooking ("This is cooking — work ahead"). Works solo and in a cook-together session.
Phase 2 (shipped): the **work-ahead nudge only shows on genuine waits** —
`Step.handsOff?` (optional, additive, no migration) tags a step hands-off vs.
needs-attention. AI import sets it (Worker `handsOff` in the step schema +
SYSTEM rule); for recipes imported before the tag, `stepIsHandsOff` in CookPage
falls back to a keyword heuristic (treat a step as a wait unless its prose
demands constant attention). `handsOff` rides through the editor draft
(passthrough, `test:draft`-guarded) so an edit never drops it; a copy carries it
like any step field. Later still: realistic per-step durations + suggesting which
upcoming steps are safe to start.
And an **owner-only recipe backup** (`.github/workflows/backup-recipes.yml` +
`scripts/backup-recipes.ts`): a weekly/manual Firestore→`backups/recipes/*.json`
snapshot committed to git, the safety net now that the app owns recipes (additive,
disaster-recovery restore via `--restore`; see Deploy tracks).
And **per-step photos** (up to 3, `Step.images`): add them in the editor
(`src/data/photos.ts` compresses in-browser → JPEG data URL → a document in the
`photos` Firestore collection; `Step.images` holds the photo doc ids), shown in
the recipe reader and cook mode (resolved back to data URLs by `usePhotoUrls`).
Members add/delete, members + guests view — enforced by `firestore.rules` on the
`photos` collection (NOT Firebase Storage: enabling Storage now needs a billing
account, which we avoid; see Deploy tracks). Copies **duplicate** the photo docs
into the new kitchen — Firestore reads/writes aren't CORS-restricted, so the copy
truly owns its bytes and is fully independent. **Removing a photo only drops the
reference from that recipe's step; the app never deletes the `photos` doc**
(matching recipe deletion), which is safe now that copies don't share bytes;
unreferenced docs just orphan, which is cheap here (a future reference-aware
sweep could reclaim them). Each photo must fit a Firestore doc (~1 MB), so
`compressToDataUrl` downscales + drops quality until it does.
And a **cover photo** per recipe (`Recipe.cover: { photo, thumb } | null`,
optional, additive — no migration): added/replaced/removed at the top of the
editor's Details. `photo` is a `photos` doc id (the full image, same pipeline and
rules as step photos — members write, members + guests read); `thumb` is the
**card image**: a 720×480 (3:2) JPEG data URL (`makeCoverThumb`, center-cropped,
~40–70 KB) stored **inline on the recipe doc**. The kitchen list shows it
**full-width atop each card** (v0.41 — the cover is how people browse a kitchen
and pick tonight's dinner) straight from the docs it already loads, so there's
no photo-doc read per card and nothing pops in while scrolling. Covers from
before v0.41 carry a 240px square `thumb` (blurry at card size):
`useCoverUpgrade` (kitchen list, members only) spots one
(`isLegacyCoverThumb`), regenerates it from the full photo, and merge-writes
just `cover` (`setRecipeCover`, no `updatedAt` bump) — once per recipe per
session; guests see the old image until a member's list upgrades it. The recipe
page shows the full photo (thumb first, swapped in when loaded); cards without a
cover look as before. A card's time is the **total** (`effectiveTotalMinutes`:
total, else prep + cook, else active) — "how long start to finish" is what you
judge at a glance, and it's the same figure the ≤20/30/45/60-min filter uses
(it used to show active time, so a 50-min roast read "15 min"). Copies duplicate the cover's photo doc like step photos; removing a
cover drops the reference only. No `firestore.rules` change (recipe fields
aren't restricted). Recipe page buttons read "Add to grocery list" / "Add to
meal plan" (they fit side by side down to 360pt).
And a **photo viewer** (`src/components/PhotoViewer.tsx`): step photos show large
on the recipe page and in cook mode (`PhotoStrip`: one photo full width, several
in a swipeable row — its step column needs `min-w-0` or the row stretches the
page sideways), and tapping one (or the recipe's cover) opens a full-screen
viewer: swipe or ‹ › through that step's photos, pinch / double-tap to zoom and
drag to pan (the app disables page zoom, so the viewer does its own), ✕ / tap
outside / Escape to close. Photos are data URLs, which iOS won't open in a new
window — the old `<a target=_blank>` gave a blank white screen. The recipe page's
ingredient list is **bulleted like Equipment** (no checkboxes; hanging bullets
so long lines wrap under their text): gathering is cook mode's per-step
checklist and shopping is the Add-to-grocery-list picker.
And an **in-app crop tool** (`src/components/PhotoCropper.tsx`, on
`react-easy-crop`): every photo added in the editor (cover or step) goes
through it — drag / pinch or slider to zoom, rotate in 90° turns, shapes
Original / Square / 4:3 / 3:4 / 16:9 (the cover is locked to 3:2, how it's
shown); Done straight away keeps the whole photo. Existing photos re-crop from
the editor (tap a step photo's ✎ / the cover's Crop), including photos a link
import brought in, before or after saving. Picked photos are first scaled to a
2048px working copy (`prepareForCrop`; 12 MP is slow and can exceed iOS canvas
limits rotated), cropped at that resolution (`cropToFile`), then compressed as
usual. A re-cropped saved photo becomes a new photo doc on save (the old one
orphans, as with removal). Full-screen overlays (crop tool, photo viewer) are
**portaled to `<body>`** — inside a `space-y-*` parent they inherited a bottom
margin that cut them short.
And a **free pasted-text importer** (`src/lib/importText.ts`, Add a recipe →
**Add from pasted text**): the cook copies a recipe — the whole page or just the recipe
section — and a rule-based, on-device parser (no network, no AI, no cost) anchors
on the "Ingredients"/"Directions" headings to pull out the title, times,
ingredients, and steps, discarding nav/headnotes/photo credits/captions/reviews,
then validates with the same `parseRecipe` → editable preview → save. Built on
the same `parseIngredientLine` as the link importer; handles both numbered and
paragraph steps; tuned against real full-page pastes in `npm run test:text`
(`scripts/fixtures/text/`). This is the free fallback for the big commercial
recipe sites (AllRecipes, Serious Eats, etc.) that block the link route's
server-side fetch.
And **kitchen-wide favorites** (`Recipe.favorite`, a shared boolean): a heart
button on each recipe card and on the reader (members toggle via
`setRecipeFavorite` — a member merge-update of just `favorite`+`updatedAt`, no
rules change; guests see a filled heart but can't toggle, same as editing).
Favorites **pin to the top** of the recipe list (the `useRecipes` sort keys on
`favorite` then title). (A "favorites only" filter was tried and removed —
redundant once they pin to the top.) `favorite` is deliberately excluded from
`RecipeSeed`, so it's toggled on
its own and a recipe edit/copy never carries or clobbers it (a copy starts
un-favorited). Shared `HeartIcon` component; `test:rules` unchanged since the
existing member-updates-recipe rule already covers it.
And **a fixed tag list** (`src/lib/tags.ts`, v0.42): tags come only from
`TAG_GROUPS` — course (breakfast, appetizers, mains, sides, desserts, snacks,
drinks, sauces), cuisine (21, regions folded in: roman → italian, sichuan →
chinese), dish (soup, pasta, noodles, …), diet (vegetarian, vegan,
pescatarian, gluten-free, dairy-free), occasion (weeknight, make-ahead,
holiday). Imports used to tag ingredients ("beef"), methods and gadgets
("pressure cooker") and sub-regions ("roman"), which cluttered the kitchen's
filter row; ingredients are searchable anyway. `normalizeTags` (synonyms →
the list, everything else dropped; imports cap at 6) runs on every source: AI
imports (`sanitizeAiRecipe`; the Worker's schema also `enum`s the list and its
prompt spells it out), a page's JSON-LD (`recipeFromJsonLd`), and editor saves
(`draftToInput`). The editor's tags are a grouped picker (`TagPicker`) instead
of free text; an older recipe's off-list tags are listed "removed when you
save". Stored tags aren't migrated — the kitchen's chips (`collectTags`), tag
filter (`useRecipeSearch`) and cards show the normalized form, so old recipes
look clean at once and are cleaned in the data when next edited.
Photos/screenshots are now handled by the free Gemini vision route (above), so
the earlier on-device OCR idea (Tesseract.js / iOS Live Text) is shelved unless a
fully-offline photo path is ever wanted. A PWA share-target ("Share → Curated
Kitchen") is **not possible on iPhone**: WebKit still doesn't implement the Web
Share Target API (bug 194593), and iOS doesn't route links into a home-screen
app (Safari and the installed app have separate storage). The iPhone flow for
links is Share → Copy in Safari, then Add from URL. Next: ownership transfer /
co-owner. The cook log is intentionally skipped —
journaling lives in ConsoliDated; this app stays focused on planning and
executing.
