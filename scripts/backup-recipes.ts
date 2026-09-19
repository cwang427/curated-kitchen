/**
 * Back up a household's recipes from Firestore into the repo, and restore them.
 *
 * This is the reverse of the old repo→Firestore sync: now that recipes are
 * authored and owned in the app, the app is the source of truth, and this keeps
 * a versioned snapshot in git so nothing is ever lost. It's a maintenance job
 * for the OWNER only — it runs in CI with the repo's service-account key and the
 * KITCHEN_HOUSEHOLD_ID variable, never in the app — so ordinary members never
 * touch it.
 *
 *   npm run backup:recipes -- --household=<householdId>            # dump (default)
 *   npm run backup:recipes -- --household=<householdId> --restore  # write back
 *
 * Dump is additive and safe: it writes one file per live recipe into
 * backups/recipes/ and never deletes (an empty read can't wipe the archive; a
 * recipe deleted in the app simply lingers in git history). Restore writes the
 * snapshot straight back to Firestore by slug — for disaster recovery only.
 */
import { cert, initializeApp, applicationDefault } from 'firebase-admin/app'
import { getFirestore, FieldValue, Timestamp } from 'firebase-admin/firestore'
import { readFileSync } from 'node:fs'
import { readdir, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const BACKUP_DIR = join(process.cwd(), 'backups', 'recipes')

interface Options {
  householdId: string
  restore: boolean
  dryRun: boolean
}

function parseArgs(): Options {
  const args = process.argv.slice(2)
  const get = (name: string): string | null => {
    const match = args.find((a) => a.startsWith(`--${name}=`))
    return match ? match.slice(name.length + 3) : null
  }
  const householdId = get('household') ?? process.env.KITCHEN_HOUSEHOLD_ID ?? null
  if (!householdId) {
    console.error('Missing --household=<householdId> (or KITCHEN_HOUSEHOLD_ID).')
    process.exit(1)
  }
  return { householdId, restore: args.includes('--restore'), dryRun: args.includes('--dry-run') }
}

function initAdmin(): void {
  const projectId = process.env.FIREBASE_PROJECT_ID
  if (!projectId) {
    console.error('Missing FIREBASE_PROJECT_ID. See .env.example.')
    process.exit(1)
  }
  const credentialsPath = process.env.GOOGLE_APPLICATION_CREDENTIALS
  if (credentialsPath) {
    const serviceAccount = JSON.parse(readFileSync(credentialsPath, 'utf8'))
    initializeApp({ credential: cert(serviceAccount), projectId })
    return
  }
  initializeApp({ credential: applicationDefault(), projectId })
}

/** Stable JSON with sorted keys, so a backup only diffs when content changes. */
function stableStringify(value: unknown): string {
  const seen = new WeakSet()
  const sort = (v: unknown): unknown => {
    if (v === null || typeof v !== 'object') return v
    if (seen.has(v as object)) return v
    seen.add(v as object)
    if (Array.isArray(v)) return v.map(sort)
    return Object.fromEntries(
      Object.keys(v as Record<string, unknown>)
        .sort()
        .map((k) => [k, sort((v as Record<string, unknown>)[k])]),
    )
  }
  return JSON.stringify(sort(value), null, 2) + '\n'
}

function toMillis(value: unknown): number | null {
  if (value instanceof Timestamp) return value.toMillis()
  return typeof value === 'number' ? value : null
}

const options = parseArgs()
initAdmin()
const db = getFirestore()

if (options.restore) {
  const files = (await readdir(BACKUP_DIR).catch(() => [])).filter((f) => f.endsWith('.json'))
  if (files.length === 0) {
    console.error(`No backups found in backups/recipes/. Nothing to restore.`)
    process.exit(1)
  }
  if (options.dryRun) {
    console.log(`Dry run — would restore ${files.length} recipe(s) to household ${options.householdId}.`)
    process.exit(0)
  }
  const batch = db.batch()
  for (const file of files) {
    const data = JSON.parse(readFileSync(join(BACKUP_DIR, file), 'utf8')) as Record<string, unknown>
    const slug = String(data.slug ?? file.replace(/\.json$/, ''))
    batch.set(db.collection('recipes').doc(slug), {
      ...data,
      id: slug,
      // Restore into the household we're told to (defaults to the backed-up one).
      householdId: options.householdId,
      createdAt: toMillis(data.createdAt) ?? FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    })
  }
  await batch.commit()
  console.log(`Restored ${files.length} recipe(s) to household ${options.householdId}.`)
  process.exit(0)
}

// Dump.
const snap = await db.collection('recipes').where('householdId', '==', options.householdId).get()
if (snap.empty) {
  // Never let an empty read wipe the archive — most likely a misconfig.
  console.log('No recipes found for that household — leaving the backup untouched.')
  process.exit(0)
}

await mkdir(BACKUP_DIR, { recursive: true })
let written = 0
for (const doc of snap.docs) {
  const data = doc.data()
  // Drop volatile/server fields so diffs reflect real content changes only.
  // createdAt is kept (as epoch ms) since it's stable; updatedAt and the
  // redundant id/householdId are dropped.
  const { updatedAt: _u, id: _i, householdId: _h, createdAt, ...rest } = data
  const record = { ...rest, slug: doc.id, createdAt: toMillis(createdAt) }
  await writeFile(join(BACKUP_DIR, `${doc.id}.json`), stableStringify(record))
  written++
}
console.log(`Backed up ${written} recipe(s) from household ${options.householdId} to backups/recipes/.`)
