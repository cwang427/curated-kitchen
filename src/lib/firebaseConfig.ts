/**
 * Firebase web config.
 *
 * These values are NOT secrets — they ship inside the client bundle no matter
 * where they're stored, which is why they're committed rather than kept in an
 * env file or a CI secret. Access is controlled by firestore.rules; that is
 * the security boundary. (Same arrangement as MatchMaker's config.js and
 * ConsoliDated's inline config.)
 *
 * To fill these in: Firebase console › Project settings › General › Your apps
 * › Web app. Paste the values, commit, push. The deploy takes it from there.
 */
export const firebaseConfig = {
  apiKey: '',
  authDomain: '',
  projectId: '',
  storageBucket: '',
  messagingSenderId: '',
  appId: '',
}

/** False until the config above is filled in — the app shows setup steps. */
export const isConfigured =
  Boolean(firebaseConfig.apiKey) &&
  Boolean(firebaseConfig.authDomain) &&
  Boolean(firebaseConfig.projectId) &&
  Boolean(firebaseConfig.appId)
