# Recipe-import Worker

This tiny Cloudflare Worker powers "Add a recipe" imports. It has **two routes**,
and you can use just the first:

- **`/url` — paste a link (FREE).** The app can't fetch another website directly
  (browsers block that — CORS), so the Worker fetches the page for you and reads
  the schema.org recipe data most cooking sites embed. **No API key, no cost.**
- **root — paste text or a photo (PAID, optional).** Sends the text/photo to
  Claude to structure it. This needs an Anthropic key, billed to you (~1–3¢ a
  recipe). Off in the app until you enable it (below).

Either way the Worker exists so secrets/keys never live in the public app, and it
checks that every caller is a signed-in member of your kitchen. Set up **once**;
runs on Cloudflare's free plan.

## What you'll need
- A free **Cloudflare** account — https://dash.cloudflare.com/sign-up
- Your **Firebase project ID** — Firebase console → Project settings → *Project ID*
  (also the `projectId` in `src/lib/firebaseConfig.ts`).
- *(Only for the paid AI route)* an **Anthropic API key** —
  https://console.anthropic.com → *API Keys* → *Create Key*.

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

## Optional: turn on the paid AI route (paste text / a photo)

Only if you want the Claude-powered text/photo import too:

1. **Add your Anthropic key as a secret** (never goes in a file):
   ```
   wrangler secret put ANTHROPIC_API_KEY
   ```
   then `wrangler deploy` again.
2. In `src/lib/aiConfig.ts`, set `AI_IMPORT_ENABLED = true`, commit, and push.
   "Paste text or a photo" then appears alongside "Paste a link".

## Choosing the model
The default is **Claude Sonnet 5** (a good, cheap fit). To use a different one,
add `ANTHROPIC_MODEL = "claude-haiku-4-5"` (cheapest) or `"claude-opus-5"`
(best) under `[vars]` in `wrangler.toml` and `wrangler deploy` again.
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
