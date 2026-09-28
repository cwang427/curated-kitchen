/**
 * Sign the recipe-import Worker in to the Internet Archive — once, from your
 * computer. The Archive's Sept 2026 access update says signed-in users don't get
 * its 429 "too many requests", which is what kept refusing link imports.
 *
 *   npm run archive:login          (or: node scripts/archive-login.mjs)
 *
 * It asks for the email + password of the app's Archive account (one made just
 * for the app — not a personal one), checks them by signing in the way the
 * Archive's own `ia` tool does, and saves three Worker secrets in one go (via
 * `wrangler secret bulk`, nothing on screen or in shell history):
 *   ARCHIVE_SESSION   the sign-in (the two session cookies) + its expiry date
 *   ARCHIVE_EMAIL,
 *   ARCHIVE_PASSWORD  so the Worker can sign itself in again when that sign-in
 *                     nears its expiry (a year) or stops working — nobody has
 *                     to come back and run this. Run it again only if you
 *                     change that account's password.
 *
 * Plain Node, no packages — works without `npm install`. Flags:
 *   --dry-run   sign in and check, but don't store anything
 */
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const LOGIN_URL = process.env.ARCHIVE_LOGIN_URL || 'https://archive.org/services/xauthn/?op=login'
const WORKER_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'worker')
const dryRun = process.argv.includes('--dry-run')

// One reader for every question, its lines taken in order (a second reader
// would miss answers the first had already buffered — e.g. when piped).
const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: Boolean(process.stdin.isTTY) })
const lines = rl[Symbol.asyncIterator]()
let muted = false
const echo = rl._writeToOutput?.bind(rl)
if (echo) rl._writeToOutput = (text) => muted || echo(text)

/** Ask a question; with `hidden`, what's typed isn't shown. */
async function ask(question, hidden = false) {
  process.stdout.write(question)
  muted = hidden && Boolean(process.stdin.isTTY)
  const { value, done } = await lines.next()
  if (muted) process.stdout.write('\n')
  muted = false
  return done ? '' : String(value).trim()
}

/** A cookie value from the sign-in reply, without any "; path=/…" attributes. */
function cookieValue(raw) {
  return typeof raw === 'string' ? raw.split(';')[0].trim() : ''
}

/** How long a cookie from the reply lasts: its Max-Age / Expires, else a year
 * (the Archive's usual). */
function cookieLifetime(raw) {
  const text = typeof raw === 'string' ? raw : ''
  const maxAge = text.match(/max-age=(\d+)/i)?.[1]
  if (maxAge) return Number(maxAge) * 1000
  const at = Date.parse(text.match(/expires=([^;]+)/i)?.[1] ?? '')
  return Number.isFinite(at) ? at - Date.now() : 365 * 24 * 60 * 60 * 1000
}

async function signIn(email, password) {
  const res = await fetch(LOGIN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': 'CuratedKitchen/1.0 (one-time sign-in for the recipe importer)',
    },
    body: new URLSearchParams({ email, password }),
  })
  const reply = await res.json().catch(() => null)
  if (!reply?.success) {
    const code = reply?.values?.reason ?? reply?.error ?? `HTTP ${res.status}`
    const why =
      code === 'account_not_found'
        ? 'No Internet Archive account with that email — check it, or create one at archive.org.'
        : code === 'account_bad_password'
          ? 'Wrong password — try again.'
          : `The Archive didn't accept the sign-in (${code}).`
    throw new Error(why)
  }
  const cookies = reply.values?.cookies ?? {}
  const user = cookieValue(cookies['logged-in-user'])
  const sig = cookieValue(cookies['logged-in-sig'])
  if (!user || !sig) throw new Error('Signed in, but the Archive sent back no session cookies — try again later.')
  const lifetime = Math.min(cookieLifetime(cookies['logged-in-user']), cookieLifetime(cookies['logged-in-sig']))
  return {
    cookie: `logged-in-user=${user}; logged-in-sig=${sig}`,
    expires: new Date(Date.now() + lifetime),
    name: reply.values?.screenname ?? email,
  }
}

/** Hand the secrets to `wrangler secret bulk` as JSON on its stdin — one upload
 * for all three, never on screen or in shell history. */
function storeSecrets(secrets) {
  return new Promise((resolve, reject) => {
    const windows = process.platform === 'win32'
    const child = spawn(windows ? 'npx.cmd' : 'npx', ['wrangler', 'secret', 'bulk'], {
      cwd: WORKER_DIR,
      stdio: ['pipe', 'inherit', 'inherit'],
      shell: windows, // Node won't run a .cmd without a shell on Windows
    })
    child.on('error', reject)
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`wrangler exited with code ${code}`))))
    child.stdin.write(JSON.stringify(secrets))
    child.stdin.end()
  })
}

async function main() {
  console.log('Sign the recipe importer in to the Internet Archive.')
  console.log('Use the Archive account you made for the app (not a personal one).\n')
  const email = await ask('Archive account email: ')
  const password = await ask('Password (hidden): ', true)
  rl.close()
  if (!email || !password) throw new Error('Need both the email and the password.')

  console.log('\nSigning in…')
  const { cookie, expires, name } = await signIn(email, password)
  console.log(`Signed in as ${name}. This sign-in lasts until ${expires.toDateString()}; the Worker renews it itself.`)

  if (dryRun) {
    console.log('Dry run — nothing stored. (Run without --dry-run to save the sign-in to the Worker.)')
    return
  }
  console.log('Saving it to the Worker (wrangler may ask you to log in to Cloudflare)…\n')
  await storeSecrets({
    ARCHIVE_SESSION: JSON.stringify({ cookie, expires: expires.toISOString() }),
    ARCHIVE_EMAIL: email,
    ARCHIVE_PASSWORD: password,
  })
  console.log('\nDone. The Worker now signs in to the Archive, and signs itself in again whenever it needs to.')
  console.log('Check: import a link with `npx wrangler tail` running — its "link: ran in" line should end "archive sign-in on (saved, …)".')
}

main().catch((error) => {
  console.error(`\n${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
})
