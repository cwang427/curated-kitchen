/**
 * Where the recipe-import Worker lives. Not a secret (like firebaseConfig) —
 * it's just a URL; the Worker itself checks that callers are signed-in members.
 *
 * Two import routes share this one Worker:
 *  - **URL import** (paste a link → read the page's schema.org data) needs ONLY
 *    this URL and a deployed Worker. It's **free** — no API key — so setting the
 *    URL below is all it takes.
 *  - **AI import** (paste text / a photo → Claude) is the paid route; it also
 *    needs the Anthropic key set on the Worker, so it stays off until you flip
 *    `AI_IMPORT_ENABLED` to true (and set that key). See worker/README.md.
 *
 * Empty until you deploy the Worker, which keeps the app building fine — the
 * Add-recipe screen simply hides whichever options aren't set up yet. Paste the
 * deployed Worker URL here, commit, and push.
 */
export const IMPORT_WORKER_URL = ''

const base = IMPORT_WORKER_URL.replace(/\/+$/, '')

/** Free URL/JSON-LD import — posts to the Worker's /url route. */
export const URL_IMPORT_URL = base ? `${base}/url` : ''
export const urlImportConfigured = URL_IMPORT_URL.length > 0

/**
 * Paid AI import. Off by default: turn this on only once the Worker has the
 * Anthropic key, otherwise the AI route just returns "not set up".
 */
export const AI_IMPORT_ENABLED = false
export const AI_IMPORT_URL = base
export const aiImportConfigured = AI_IMPORT_ENABLED && AI_IMPORT_URL.length > 0
