/**
 * Push recipes/*.json into Firestore.
 *
 * The JSON files are the source of truth: a recipe's document id is its slug,
 * so re-running this is idempotent and edits to a file overwrite the document.
 * `createdAt` and `createdBy` survive re-syncs.
 *
 *   npm run sync:recipes -- --household=<householdId> [--dry-run] [--only=slug] [--prune]
 *
 * --prune makes the repo authoritative: household recipes whose slug no longer
 * has a file are deleted, so renaming or removing a recipes/*.json file removes
 * the stale document instead of leaving a duplicate. CI passes it; it is
 * refused alongside --only, which only touches one recipe.
 */
import { cert, initializeApp, applicationDefault } from 'firebase-admin/app'
import { getFirestore, FieldValue } from 'firebase-admin/firestore'
import { readFileSync } from 'node:fs'
import { loadRecipes } from './recipe-files'

interface Options {
  householdId: string
  dryRun: boolean
  only: string | null
  prune: boolean
}

function parseArgs(): Options {
  const args = process.argv.slice(2)
  const get = (name: string): string | null => {
    const match = args.find((a) => a.startsWith(`--${name}=`))
    return match ? match.slice(name.length + 3) : null
  }

  const householdId = get('household') ?? process.env.KITCHEN_HOUSEHOLD_ID ?? null
  if (!householdId) {
    console.error(
      'Missing --household=<householdId>.\n' +
        'Find it in the Firestore console under the "households" collection, ' +
        'or set KITCHEN_HOUSEHOLD_ID in your environment.',
    )
    process.exit(1)
  }

  const only = get('only')
  const prune = args.includes('--prune')
  if (prune && only) {
    console.error('--prune cannot be combined with --only (it would delete every other recipe).')
    process.exit(1)
  }

  return { householdId, dryRun: args.includes('--dry-run'), only, prune }
}

function initAdmin(): void {
  const projectId = process.env.FIREBASE_PROJECT_ID
  const credentialsPath = process.env.GOOGLE_APPLICATION_CREDENTIALS

  if (!projectId) {
    console.error('Missing FIREBASE_PROJECT_ID. See .env.example.')
    process.exit(1)
  }

  if (credentialsPath) {
    try {
      const serviceAccount = JSON.parse(readFileSync(credentialsPath, 'utf8'))
      initializeApp({ credential: cert(serviceAccount), projectId })
      return
    } catch (error) {
      console.error(
        `Could not read the service account at ${credentialsPath}: ` +
          `${error instanceof Error ? error.message : String(error)}`,
      )
      process.exit(1)
    }
  }

  // Falls back to gcloud application-default credentials.
  initializeApp({ credential: applicationDefault(), projectId })
}

const options = parseArgs()
const { loaded, errors } = await loadRecipes()

if (errors.length > 0) {
  console.error('Refusing to sync — fix these first:\n')
  for (const { file, message } of errors) {
    console.error(`✗ ${file}\n${message}`)
  }
  process.exit(1)
}

const selected = options.only
  ? loaded.filter((r) => r.recipe.slug === options.only)
  : loaded

if (selected.length === 0) {
  console.error(options.only ? `No recipe matched --only=${options.only}` : 'No recipes found.')
  process.exit(1)
}

for (const { file, warnings } of selected) {
  for (const warning of warnings) console.warn(`  ! ${file}: ${warning}`)
}

if (options.dryRun) {
  console.log(`\nDry run — would sync ${selected.length} recipe(s) to household ${options.householdId}:`)
  for (const { recipe } of selected) console.log(`  · ${recipe.slug} — ${recipe.title}`)
  process.exit(0)
}

initAdmin()
const db = getFirestore()

const household = await db.collection('households').doc(options.householdId).get()
if (!household.exists) {
  console.error(
    `Household "${options.householdId}" does not exist. Sign in to the app ` +
      `once to create one, then pass its id here.`,
  )
  process.exit(1)
}

const batch = db.batch()
let created = 0
let updated = 0

for (const { recipe } of selected) {
  const ref = db.collection('recipes').doc(recipe.slug)
  const existing = await ref.get()
  existing.exists ? updated++ : created++

  batch.set(
    ref,
    {
      ...recipe,
      id: recipe.slug,
      householdId: options.householdId,
      createdBy: existing.data()?.createdBy ?? null,
      createdAt: existing.data()?.createdAt ?? FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    },
    { merge: false },
  )
}

await batch.commit()
console.log(
  `\nSynced ${selected.length} recipe(s) to household ${options.householdId} ` +
    `(${created} created, ${updated} updated).`,
)

if (options.prune) {
  // The repo is the source of truth: any recipe in this household without a
  // matching file is stale (a rename or a deletion) and gets removed.
  const localSlugs = new Set(loaded.map((r) => r.recipe.slug))
  const existing = await db
    .collection('recipes')
    .where('householdId', '==', options.householdId)
    .get()

  const stale = existing.docs.filter((doc) => !localSlugs.has(doc.id))
  if (stale.length === 0) {
    console.log('Prune: nothing stale to remove.')
  } else {
    const pruneBatch = db.batch()
    for (const doc of stale) pruneBatch.delete(doc.ref)
    await pruneBatch.commit()
    console.log(`Prune: removed ${stale.length} recipe(s) with no file — ${stale.map((d) => d.id).join(', ')}.`)
  }
}
