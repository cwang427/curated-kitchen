import { initializeApp } from 'firebase/app'
import { firebaseConfig } from './firebaseConfig'
import { GoogleAuthProvider, getAuth } from 'firebase/auth'
import {
  initializeFirestore,
  persistentLocalCache,
  persistentMultipleTabManager,
} from 'firebase/firestore'

const app = initializeApp(firebaseConfig)

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
