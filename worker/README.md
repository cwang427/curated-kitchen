# Recipe-import Worker

This tiny Cloudflare Worker powers "Add a recipe" imports. It has **two routes**,
and you can use just the first:

- **`/url` — paste a link (FREE).** The app can't fetch another website directly
  (browsers block that — CORS), so the Worker fetches the page for you and reads
  the schema.org recipe data most cooking sites embed. **No API key, no cost.**
- **root — paste text or a photo (FREE with Gemini).** Sends the text/photo to
  Google's Gemini to structure it. This reads *any* layout (blog-style pages that
  the link route can't) and photos/screenshots. It uses Gemini's **free tier**
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

2. **Put your Firebase project ID into `wrangler.toml`** — replace
   `REPLACE_WITH_YOUR_FIREBASE_PROJECT_ID`. If your app isn't hosted at
   `https://cwang427.github.io`, fix `ALLOWED_ORIGIN` too (it's your GitHub
   Pages origin, with no path).

3. **Deploy**
   ```
   wrangler deploy
   ```
   It prints a URL like `https://curated-kitchen-import.<you>.workers.dev`.

4. **Tell the app the URL.** Put that URL into `src/lib/aiConfig.ts`
   (`IMPORT_WORKER_URL`), commit, and push. The app redeploys automatically
   (~2 min), and **"Paste a link"** turns on in Add a recipe.

## Turn on the AI route (paste text / a photo) — free with Gemini

This is what makes text pastes work on *any* site and reads photos/screenshots:

1. **Add your Gemini key as a secret** (never goes in a file):
   ```
   wrangler secret put GEMINI_API_KEY
   ```
   Paste the AI Studio key at the prompt, then `wrangler deploy` again.
2. In `src/lib/aiConfig.ts`, set `AI_IMPORT_ENABLED = true`, commit, and push.
   In Add a recipe, "Paste text" then uses Gemini (falling back to the on-device
   reader if the free limit is hit), and **"Scan a photo"** appears.

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
The default is **gemini-3.5-flash** (free, reads images), with an automatic
fallback to **gemini-3.5-flash-lite** when the primary is briefly overloaded
(a 503 "high demand" spike). We don't lead with the newest flagship
(gemini-3.6-flash) because, while it's free too, it's popular enough to throw
sustained 503s. To force a single model with no fallback — e.g. to try
gemini-3.6-flash once it's calmed down — add `GEMINI_MODEL = "gemini-3.6-flash"`
under `[vars]` in `wrangler.toml` and `wrangler deploy` again (no code change).
If the Worker ever 404s with "no longer available," that model id was retired —
bump it the same way. Free-tier model availability and limits change over time;
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
Open the app → Recipes → **Add** → **Paste a link**, paste a recipe URL, and tap
**Read recipe**. If you get "Not signed in", the token check is failing (check
`FIREBASE_PROJECT_ID`). "That site blocked the import" or "No structured recipe
data" means that particular page can't be read — normal for some sites; use paste
or a photo. Worker logs: `wrangler tail`.

## Security notes
- The key lives only in Cloudflare (as a secret), never in the repo or the app.
- Every request must carry a valid Firebase sign-in token for your project, so
  only people signed into your kitchen can use it.
- `ALLOWED_ORIGIN` limits browser calls to your app's origin.
