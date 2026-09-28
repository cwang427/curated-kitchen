/**
 * Sign the recipe-import Worker in to the Internet Archive — once, from your
 * computer. The Archive's Sept 2026 access update says signed-in users don't get
 * its 429 "too many requests", which is what kept refusing link imports.
 *
 *   npm run archive:login          (or: node scripts/archive-login.mjs)
 *
 * It asks for the email + password of the app's Archive account, signs in the
 * same way the Archive's own `ia` tool does, and stores ONLY the two session
 * cookies it gets back as the Worker secret ARCHIVE_COOKIES (via `wrangler
 * secret put`). The password is used for that one request and never saved.
 * Run it again if the tail ever says the sign-in may have expired.
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
  const user = cookieValue(reply.values?.cookies?.['logged-in-user'])
  const sig = cookieValue(reply.values?.cookies?.['logged-in-sig'])
  if (!user || !sig) throw new Error('Signed in, but the Archive sent back no session cookies — try again later.')
  return { cookie: `logged-in-user=${user}; logged-in-sig=${sig}`, name: reply.values?.screenname ?? email }
}

/** Hand the cookie to `wrangler secret put ARCHIVE_COOKIES` on its stdin, so it
 * never appears on screen or in shell history. */
function storeSecret(value) {
  return new Promise((resolve, reject) => {
    const windows = process.platform === 'win32'
    const child = spawn(windows ? 'npx.cmd' : 'npx', ['wrangler', 'secret', 'put', 'ARCHIVE_COOKIES'], {
      cwd: WORKER_DIR,
      stdio: ['pipe', 'inherit', 'inherit'],
      shell: windows, // Node won't run a .cmd without a shell on Windows
    })
    child.on('error', reject)
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`wrangler exited with code ${code}`))))
    child.stdin.write(value + '\n')
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
  const { cookie, name } = await signIn(email, password)
  console.log(`Signed in as ${name}.`)

  if (dryRun) {
    console.log('Dry run — nothing stored. (Run without --dry-run to save the sign-in to the Worker.)')
    return
  }
  console.log('Saving the sign-in to the Worker (wrangler may ask you to log in to Cloudflare)…\n')
  await storeSecret(cookie)
  console.log('\nDone. The Worker now signs in to the Archive; the tail will say "archive sign-in on".')
}

main().catch((error) => {
  console.error(`\n${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
})
