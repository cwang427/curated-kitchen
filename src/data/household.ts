import {
  doc,
  getDoc,
  serverTimestamp,
  setDoc,
  updateDoc,
  type DocumentData,
} from 'firebase/firestore'
import type { User } from 'firebase/auth'
import { db } from '../lib/firebase'
import type { Household, UserProfile } from '../lib/types'

function toHousehold(id: string, data: DocumentData): Household {
  return {
    id,
    name: data.name ?? 'My Kitchen',
    ownerUid: data.ownerUid,
    memberUids: data.memberUids ?? [],
    friendUids: data.friendUids ?? [],
    createdAt: data.createdAt?.toMillis?.() ?? null,
  }
}

function toProfile(uid: string, data: DocumentData): UserProfile {
  return {
    uid,
    displayName: data.displayName ?? null,
    email: data.email ?? null,
    photoURL: data.photoURL ?? null,
    householdIds: data.householdIds ?? [],
    defaultHouseholdId: data.defaultHouseholdId ?? null,
  }
}

function defaultHouseholdName(user: User): string {
  const first = user.displayName?.trim().split(/\s+/)[0]
  return first ? `${first}'s Kitchen` : 'My Kitchen'
}

/**
 * Called on every sign-in. Creates the user's profile and a starter
 * household the first time, and keeps the profile's display fields in sync
 * with their Google account afterwards.
 */
export async function ensureUserAndHousehold(
  user: User,
): Promise<{ profile: UserProfile; household: Household }> {
  const userRef = doc(db, 'users', user.uid)
  const snapshot = await getDoc(userRef)

  const identity = {
    displayName: user.displayName,
    email: user.email,
    photoURL: user.photoURL,
  }

  if (snapshot.exists()) {
    const existing = toProfile(user.uid, snapshot.data())

    // Refresh the cached identity if Google's copy has changed.
    const stale =
      existing.displayName !== identity.displayName ||
      existing.email !== identity.email ||
      existing.photoURL !== identity.photoURL
    if (stale) await updateDoc(userRef, identity)

    const householdId = existing.defaultHouseholdId ?? existing.householdIds[0] ?? null
    if (householdId) {
      const householdSnapshot = await getDoc(doc(db, 'households', householdId))
      if (householdSnapshot.exists()) {
        return {
          profile: { ...existing, ...identity },
          household: toHousehold(householdSnapshot.id, householdSnapshot.data()),
        }
      }
    }
    // Profile exists but its household is gone — fall through and make one.
  }

  // The rules require ownerUid == uid and memberUids == [uid] at creation,
  // so a new household always starts as a household of one.
  const householdRef = doc(db, 'households', `hh_${user.uid.slice(0, 12)}`)
  const householdData = {
    name: defaultHouseholdName(user),
    ownerUid: user.uid,
    memberUids: [user.uid],
    friendUids: [],
    createdAt: serverTimestamp(),
  }
  await setDoc(householdRef, householdData)

  const profileData = {
    ...identity,
    householdIds: [householdRef.id],
    defaultHouseholdId: householdRef.id,
  }
  await setDoc(userRef, profileData, { merge: true })

  return {
    profile: toProfile(user.uid, profileData),
    household: toHousehold(householdRef.id, { ...householdData, createdAt: null }),
  }
}
