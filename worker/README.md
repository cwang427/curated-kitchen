# Recipe-import Worker

This tiny Cloudflare Worker is what lets the app turn a pasted recipe or a photo
into a structured recipe. It exists for one reason: **the Anthropic API key can
never live in the app** (the app is public — anyone could read it). The Worker
holds the key, checks that whoever's calling is a signed-in member of your
kitchen, then asks Claude to do the conversion.

You set this up **once**. It runs on Cloudflare's free plan.

## What you'll need
- A free **Cloudflare** account — https://dash.cloudflare.com/sign-up
- An **Anthropic API key** — https://console.anthropic.com → *API Keys* → *Create Key*.
  (This is billed to you. Parsing a recipe costs about 1–3¢.)
- Your **Firebase project ID** — Firebase console → Project settings → *Project ID*
  (it's also the `projectId` in `src/lib/firebaseConfig.ts`).

## Deploy (about 10 minutes)

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

3. **Add your Anthropic key as a secret** (this never goes in the file):
   ```
   wrangler secret put ANTHROPIC_API_KEY
   ```
   Paste the key when prompted.

4. **Deploy**
   ```
   wrangler deploy
   ```
   It prints a URL like `https://curated-kitchen-import.<you>.workers.dev`.

5. **Tell the app the URL.** Put that URL into `src/lib/aiConfig.ts`
   (`AI_IMPORT_URL`), commit, and push. The app redeploys automatically (~2 min),
   and the "Add recipe" screen turns on.

## Choosing the model
The default is **Claude Sonnet 5** (a good, cheap fit). To use a different one,
add `ANTHROPIC_MODEL = "claude-haiku-4-5"` (cheapest) or `"claude-opus-5"`
(best) under `[vars]` in `wrangler.toml` and `wrangler deploy` again.
If you pick a Fable-family model later, forced `tool_choice` isn't supported
there — switch the request to structured outputs (`output_config.format`); ping
me and I'll make that change.

## Testing it worked
After step 5, open the app → Recipes → **Add**, paste a recipe, and tap
**Read recipe**. If you get "Not signed in", the token check is failing (check
`FIREBASE_PROJECT_ID`). If you get an AI-service error, check the secret key.
Worker logs: `wrangler tail`.

## Security notes
- The key lives only in Cloudflare (as a secret), never in the repo or the app.
- Every request must carry a valid Firebase sign-in token for your project, so
  only people signed into your kitchen can use it.
- `ALLOWED_ORIGIN` limits browser calls to your app's origin.
