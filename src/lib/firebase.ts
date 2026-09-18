import { initializeApp } from 'firebase/app'
import { GoogleAuthProvider, getAuth } from 'firebase/auth'
import {
  initializeFirestore,
  persistentLocalCache,
  persistentMultipleTabManager,
} from 'firebase/firestore'

// Static property access matters: Vite only substitutes literal
// `import.meta.env.VITE_*` references at build time.
const config = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID,
}

const REQUIRED = ['apiKey', 'authDomain', 'projectId', 'appId'] as const
const missing = REQUIRED.filter((key) => !config[key])

if (missing.length > 0) {
  const names = missing.map((key) => `VITE_FIREBASE_${key.replace(/[A-Z]/g, (c) => `_${c}`).toUpperCase()}`)
  throw new Error(
    `Missing Firebase config: ${names.join(', ')}.\n` +
      `Copy .env.example to .env.local and fill in the values from the ` +
      `Firebase console (Project settings \u203a General \u203a Your apps).`,
  )
}

const app = initializeApp(config)

export const auth = getAuth(app)
export const googleProvider = new GoogleAuthProvider()

/**
 * Persistent cache means the recipe you opened at home still renders in a
 * basement kitchen with no signal, and grocery check-offs made in the store
 * sync when you surface. Multi-tab manager keeps phone-and-laptop use sane.
 */
export const db = initializeFirestore(app, {
  localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }),
})
