/**
 * Are the Firestore rules that are LIVE the same as firestore.rules here?
 *
 * Rules don't deploy with the app — the owner re-publishes them by hand in the
 * Firebase console — so "did my re-publish take?" is a real question, and the
 * #1 source of "it didn't work". This reads the published rules with the
 * repo's service-account key (owner-only: it runs in CI, never in the app)
 * and compares them with the file, ignoring line endings and trailing spaces
 * (a paste into the console can change those).
 *
 *   npm run check:rules     (needs GOOGLE_APPLICATION_CREDENTIALS + FIREBASE_PROJECT_ID)
 *
 * Exit 0 = they match; 1 = they differ (re-publish); 2 = couldn't check.
 * In GitHub Actions it also writes a plain-English summary for the run page.
 */
import { appendFileSync, readFileSync } from 'node:fs'
import { applicationDefault, cert, initializeApp } from 'firebase-admin/app'
import { getSecurityRules } from 'firebase-admin/security-rules'

const summary = (text: string) => {
  console.log(text)
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${text}\n`)
}

/** Same rules if they read the same: line endings and trailing spaces don't count. */
export function normalizeRules(source: string): string[] {
  return source
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/\s+$/, ''))
    .join('\n')
    .trim()
    .split('\n')
}

async function main(): Promise<void> {
  const projectId = process.env.FIREBASE_PROJECT_ID
  if (!projectId) {
    summary('### Couldn’t check the rules\nMissing FIREBASE_PROJECT_ID.')
    process.exit(2)
  }
  const keyPath = process.env.GOOGLE_APPLICATION_CREDENTIALS
  initializeApp({
    credential: keyPath ? cert(JSON.parse(readFileSync(keyPath, 'utf8'))) : applicationDefault(),
    projectId,
  })

  let live: string
  let published: string
  try {
    const ruleset = await getSecurityRules().getFirestoreRuleset()
    live = ruleset.source.map((file) => file.content).join('\n')
    published = ruleset.createTime
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause)
    summary(
      [
        '### Couldn’t check the rules',
        `The service account couldn’t read the published rules: ${message}`,
        '',
        'It needs permission to *view* Firebase rules. One-time fix: Google Cloud console › IAM › the',
        'service account in the FIREBASE_SERVICE_ACCOUNT secret › Edit › Add role › **Firebase Rules Viewer**.',
      ].join('\n'),
    )
    process.exit(2)
  }

  const want = normalizeRules(readFileSync('firestore.rules', 'utf8'))
  const have = normalizeRules(live)
  const when = new Date(published).toUTCString()
  if (want.join('\n') === have.join('\n')) {
    summary(`### ✅ The published rules match firestore.rules\nLast published ${when}.`)
    return
  }

  // Show where they part ways, so it's clear what's missing.
  let first = 0
  while (first < want.length && first < have.length && want[first] === have[first]) first++
  const show = (lines: string[]) => lines.slice(first, first + 6).map((l) => `    ${l}`).join('\n') || '    (nothing — it ends here)'
  summary(
    [
      '### ❌ The published rules are different from firestore.rules',
      `Last published ${when}. They differ from line ${first + 1}.`,
      '',
      'This branch’s firestore.rules has:',
      show(want),
      '',
      'The published rules have:',
      show(have),
      '',
      'To fix: Firebase console › Firestore Database › Rules › replace everything with the',
      'contents of firestore.rules › Publish. Then run this check again.',
    ].join('\n'),
  )
  process.exit(1)
}

void main()
