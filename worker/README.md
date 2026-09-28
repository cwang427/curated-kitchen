# Recipe-import Worker

This tiny Cloudflare Worker powers "Add a recipe" imports. It has **two routes**,
and you can use just the first:

- **`/url` — paste a link (FREE).** The app can't fetch another website directly
  (browsers block that — CORS), so the Worker fetches the page for you and reads
  the schema.org recipe data most cooking sites embed. **No API key, no cost.**
  Many big sites block this fetch, so with Gemini set up it's only the fallback.
- **root — paste text, a photo/PDF, or a link (FREE with Gemini).** Sends the
  text/photo to Google's Gemini to structure it. This reads *any* layout
  (blog-style pages that the `/url` route can't) and photos/screenshots/PDFs. For
  a **link** (`{ url }`), the Worker fetches the page itself — directly, then
  via **Jina Reader** (`r.jina.ai`, a free page-reading service, no key), then
  the **Internet Archive's** saved copy (its quick lookup, then its full index
  when the quick one comes up empty; waiting and retrying when the Archive says
  "too many requests", then asking Jina to fetch the Archive's copy) — and
  has Gemini read it as text. Only if none of those get the page does Gemini
  try reading the link itself (its URL-context tool). Paywalled pages don't
  work. Only the public
  recipe link is sent to those services. It also returns the links of the
  page's own photos (the main one plus any per-step photos — each as a few
  sizes, tried in turn), which the app
  downloads through **`/img`** — a pass-through that streams images only (from
  the site, else the Archive's copy fetched via **wsrv.nl**, a free public image
  proxy — so our own requests don't use up the Archive's allowance for the
  page — else wsrv.nl for the site's image; only public photo links are sent to
  it). For sites that refuse all of those, an optional free **Firecrawl** key
  (below) fetches the page — and, as a last resort, its photos. The whole
  search takes well under a minute: every route has its own
  time limit, and after the Archive turns us away (it does, for a few minutes
  at a time) the Worker stops asking it for page copies for a while (90 s,
  growing to 10 minutes if it keeps refusing). When only Google's reader could
  read the recipe, it comes without photos, and the app asks the cook: continue
  without them, or try again once the Archive should be free. Tags come only from the app's fixed
  list (`src/lib/tags.ts`, bundled into the Worker by wrangler — it's in the
  repo, so a normal pull brings it). It uses Gemini's **free tier**
  (an AI Studio key with **no billing**), plenty for a household's occasional
  imports. Off in the app until you enable it (below). *(A paid Anthropic Claude
  route is also supported as an alternative — see the end.)*

Either way the Worker exists so secrets/keys never live in the public app, and it
checks that every caller is a signed-in member of your kitchen. Set up **once**;
runs on Cloudflare's free plan.

## What you'll need
- A free **Cloudflare** account — https://dash.cloudflare.com/sign-up
- Your **Firebase project ID** — Firebase console → Project settings → *Project ID*
  (also the `projectId` in `src/lib/firebaseConfig.ts`).
- *(For the AI text/photo route)* a **free Gemini API key** — https://aistudio.google.com/apikey
  → *Create API key*. Sign in with a Google account; you do **not** need to add
  a billing account for the free tier.

## Deploy (about 10 minutes) — free URL import

From a computer with Node installed, in this `worker/` folder:

1. **Install the Cloudflare CLI and log in**
   ```
   npm install -g wrangler
   wrangler login
   ```
   (`wrangler login` opens your browser to authorize.)

2. **Check your Firebase project ID in `wrangler.toml`** — `FIREBASE_PROJECT_ID`
   under `[vars]` must be your Firebase project's ID. If your app isn't hosted at
   `https://cwang427.github.io`, fix `ALLOWED_ORIGIN` too (it's your GitHub
   Pages origin, with no path).

3. **Deploy**
   ```
   wrangler deploy
   ```
   It prints a URL like `https://curated-kitchen-import.<you>.workers.dev`.

4. **Tell the app the URL.** Put that URL into `src/lib/aiConfig.ts`
   (`IMPORT_WORKER_URL`), commit, and push. The app redeploys automatically
   (~2 min), and **"Add from URL"** turns on in Add a recipe.

## Turn on the AI route (paste text / a photo) — free with Gemini

This is what makes text pastes work on *any* site and reads photos/screenshots:

1. **Add your Gemini key as a secret** (never goes in a file):
   ```
   wrangler secret put GEMINI_API_KEY
   ```
   Paste the AI Studio key at the prompt, then `wrangler deploy` again.
2. In `src/lib/aiConfig.ts`, set `AI_IMPORT_ENABLED = true`, commit, and push.
   In Add a recipe, "Paste text" then uses Gemini (falling back to the on-device
   reader if the free limit is hit), and **"Add from photo or PDF"** appears.

## Sign the Worker in to the Internet Archive (recommended)

Sites like Serious Eats block the Worker, so links from them are read from the
Internet Archive's saved copy. The Archive answers anonymous requests from
Cloudflare's shared addresses with "429 too many requests" more and more often,
and its Sept 2026 access update says **signed-in users don't get that error**.
So the Worker signs in with an Archive account — one-time setup, nothing for
anyone else to do:

1. **Make an Archive account just for the app** at archive.org → *Sign up*
   (free). Give it its own password, and confirm the email it sends. Don't use a
   personal account: the stored sign-in lets the Worker act as that account.
2. **Sign the Worker in**, from the repo folder on your computer:
   ```
   node scripts/archive-login.mjs
   ```
   (or `npm run archive:login`). Enter that account's email and password. It
   checks them by signing in (the way the Archive's own `ia` tool does), then
   saves three Worker secrets in one go (`wrangler secret bulk` — wrangler may
   ask you to log in to Cloudflare first): the sign-in with its expiry date,
   and the account's email + password. `--dry-run` just checks the sign-in.
3. Import a link and look at `wrangler tail`: the `link: ran in …` line should
   end with **`archive sign-in on (saved, until …)`**.

**It keeps itself signed in — nobody needs to come back and run this.** The
Archive's sign-ins last a year. The Worker uses the saved one until a day before
it expires, then signs itself in again with the stored email + password. (It
doesn't sign in again when the Archive turns a request away: that's the Archive
being busy, not the sign-in going stale — the app offers "Try again" instead.)
If signing in ever fails
(say the account's password was changed), imports simply carry on as if it
weren't set up, it tries again after 10 minutes, and the tail says
`archive sign-in: failed (…)` — then run step 2 again. The sign-in and password
are sent only to the Archive's own sites, never to the image proxy, Jina, or a
recipe site.

## Add Firecrawl for sites that block everything else (optional, free)
Some big recipe sites (Serious Eats and the rest of Dotdash Meredith) refuse the
Worker, Jina and Google alike, and the Internet Archive's copies of them are
often busy. **Firecrawl** (firecrawl.dev) fetches pages from its own servers,
retrying through proxies that look like ordinary visitors — so those imports
come through with their photos. Its **free plan** needs no card: 1,000 credits
a month, 1 credit per page or photo (plenty for a household). The Worker uses it
only when the free routes fail, alongside the Archive (whichever brings the
recipe first wins), and for a photo only after every free route failed.
When the month's credits run out it just pauses itself and imports carry on
through the Archive as before — nobody has to do anything.

1. Sign up at **firecrawl.dev** (free plan) and copy your **API key** (it
   starts with `fc-`) from the dashboard.
2. From this `worker/` folder:
   ```
   npx wrangler secret put FIRECRAWL_API_KEY
   ```
   and paste the key when asked (it isn't shown or saved anywhere else).
3. Import a Serious Eats link with `npx wrangler tail` running: the `link: ran
   in …` line ends **`firecrawl on (N credits left until …)`**, and the page
   line reads `page unlocker: recipe data found`.

(Sites that block automated reading generally say so in their terms of use;
this is for a household's own occasional imports, one page at a time. Only the
public recipe link goes to Firecrawl.)

## Updating the Worker later (IMPORTANT)
`wrangler deploy` ships the code **on your computer**, not from GitHub. So when
the Worker code changes, first pull the update to your computer, *then* deploy:
```
git checkout <working branch>   # the branch the app is deploying from
git pull
cd worker
npx wrangler deploy
```
If you skip the pull, you'll just re-upload the old version and the change won't
take effect (the app itself is different — it always deploys the latest from
GitHub automatically). To confirm you have the update, `git log --oneline -3`
should show the recent commits before you deploy.

## Choosing the model
The default is **gemini-3.5-flash-lite** (free, reads images), with an automatic
fallback to **gemini-3.5-flash**. On the free tier the fuller flash models are
heavily contended — they throw sustained 503s and sometimes just hang — while
`-lite` reliably answers and is plenty for reading a recipe. To force a single
model with no fallback — e.g. to try the flagship `gemini-3.6-flash` once the
free tier is less busy — add `GEMINI_MODEL = "gemini-3.6-flash"` under `[vars]`
in `wrangler.toml` and `wrangler deploy` again (no code change). If the Worker
ever 404s with "no longer available," that model id was retired — bump it the
same way. Free-tier model availability and limits change over time;
see https://aistudio.google.com/docs/rate-limits.

## Optional: use paid Anthropic Claude instead
If you'd rather use Claude (paid, ~1–3¢ a recipe): set `ANTHROPIC_API_KEY`
instead of `GEMINI_API_KEY` (`wrangler secret put ANTHROPIC_API_KEY`) and don't
set a Gemini key — the Worker uses Claude only when no Gemini key is present.
The default Claude model is **Sonnet 5**; override with
`ANTHROPIC_MODEL = "claude-haiku-4-5"` (cheapest) or `"claude-opus-5"` (best).
If you pick a Fable-family model later, forced `tool_choice` isn't supported
there — switch the request to structured outputs (`output_config.format`); ping
me and I'll make that change.

## Testing it worked
Open the app → Recipes → **Add** → **Add from URL**, paste a recipe URL, and tap
**Read recipe**. If you get "Not signed in", the token check is failing (check
`FIREBASE_PROJECT_ID`). "Couldn't open that page" or "behind a paywall" means
Google couldn't read that particular page — normal for paywalled sites; use paste
or a photo. Worker logs: `wrangler tail`, or afterwards in the Cloudflare
dashboard → Workers & Pages → curated-kitchen-import → **Logs** (kept 3 days).
A link logs `page direct/reader/archive: …` for each route it tried — a `429`
there is the Archive saying "slow down", after which `archive breaker: not
asking for page copies for 90s` and later imports log `page archive …: skipped`
until it's over — then `gemini url statuses=…` only if it fell back to Google's
reader (`link: asking Google to read the Archive's copy` for a blocked site).
Every import ends with one `{ event: 'import', host, via, ms, … }` line: which
site, which route worked, how long it took, and whether photos came. Each photo then logs one line, e.g. `img ok
[site 403 → proxy/archive 200] www.example.com/…/salmon.jpg` — every route it tried, in order, and
the end of the photo's link (shortened on purpose). The `link: ran in …` line ends with **`worker 0.x.y`** —
the version that's deployed. If it's older than the one in your copy (see
`package.json`), or missing, pull, then `npx wrangler deploy`.

Code changes: the Worker's code is `src/importer.ts` (`src/index.ts` only hands
it to Cloudflare). Run `npm run test:worker` from the repo root after changing it.

## Security notes
- The key lives only in Cloudflare (as a secret), never in the repo or the app.
  So does the Archive sign-in (`ARCHIVE_SESSION`, `ARCHIVE_EMAIL`,
  `ARCHIVE_PASSWORD`) — for an Archive account made just for the app (so its
  password isn't one you use anywhere else), and sent only to archive.org /
  web.archive.org — and the Firecrawl key (`FIRECRAWL_API_KEY`), sent only to
  api.firecrawl.dev.
- Every request must carry a valid Firebase sign-in token for your project, so
  only people signed into your kitchen can use it.
- `ALLOWED_ORIGIN` limits browser calls to your app's origin.
