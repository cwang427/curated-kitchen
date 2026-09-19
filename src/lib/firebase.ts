import { initializeApp } from 'firebase/app'
import { firebaseConfig } from './firebaseConfig'
import { getAuth } from 'firebase/auth'
import {
  initializeFirestore,
  persistentLocalCache,
  persistentMultipleTabManager,
} from 'firebase/firestore'
import { getStorage } from 'firebase/storage'

const app = initializeApp(firebaseConfig)

export const auth = getAuth(app)

/** Firebase Storage — holds step photos (see src/data/photos.ts). */
export const storage = getStorage(app)

/**
 * Persistent cache means the recipe you opened at home still renders in a
 * basement kitchen with no signal, and grocery check-offs made in the store
 * sync when you surface. Multi-tab manager keeps phone-and-laptop use sane.
 */
export const db = initializeFirestore(app, {
  localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }),
})
