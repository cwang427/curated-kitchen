/**
 * Where the recipe-import Worker lives. Not a secret (like firebaseConfig) —
 * it's just a URL; the Worker itself checks that callers are signed-in members.
 *
 * Two import routes share this one Worker:
 *  - **URL import** (paste a link → read the page's schema.org data) needs ONLY
 *    this URL and a deployed Worker. It's **free** — no API key — so setting the
 *    URL below is all it takes.
 *  - **AI import** (paste text / a photo → Gemini) is the smart route: it reads
 *    any layout and photos/screenshots. It uses Google's **free** Gemini tier
 *    (an AI Studio key with no billing), set as a Worker secret — never in this
 *    public app. It stays off until you add that key and flip
 *    `AI_IMPORT_ENABLED` to true. See worker/README.md.
 *
 * Empty until you deploy the Worker, which keeps the app building fine — the
 * Add-recipe screen simply hides whichever options aren't set up yet. Paste the
 * deployed Worker URL here, commit, and push.
 */
export const IMPORT_WORKER_URL = 'https://curated-kitchen-import.curated-kitchen.workers.dev'

const base = IMPORT_WORKER_URL.replace(/\/+$/, '')

/** Free URL/JSON-LD import — posts to the Worker's /url route. */
export const URL_IMPORT_URL = base ? `${base}/url` : ''
export const urlImportConfigured = URL_IMPORT_URL.length > 0

/**
 * AI import (free Gemini tier). Off by default: turn this on only once the
 * Worker has the GEMINI_API_KEY secret, otherwise the AI route just returns
 * "not set up". When on, it's the default engine for text pastes (the on-device
 * parser stays the offline/rate-limit fallback) and the only engine for photos.
 */
export const AI_IMPORT_ENABLED = true
export const AI_IMPORT_URL = base
export const aiImportConfigured = AI_IMPORT_ENABLED && AI_IMPORT_URL.length > 0
