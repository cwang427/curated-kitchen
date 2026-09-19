import {
  arrayRemove,
  arrayUnion,
  collection,
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
    inviteCode: data.inviteCode ?? null,
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
    pendingInvite: data.pendingInvite ?? null,
  }
}

/**
 * Accounts are created in the Firebase console, which has no display-name
 * field, so email/password users arrive with displayName null. Derive
 * something readable from the address: "mr.soccerboy@..." → "Mr Soccerboy".
 */
function nameFromEmail(email: string | null): string {
  const local = email?.split('@')[0]
  if (!local) return 'Cook'
  const words = local
    .split(/[._+-]+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
  return words.join(' ') || 'Cook'
}

function defaultHouseholdName(displayName: string): string {
  const first = displayName.trim().split(/\s+/)[0]
  return first ? `${first}'s Kitchen` : 'My Kitchen'
}

/**
 * Called on every sign-in. Creates the user's profile and a starter
 * household the first time, and keeps the cached profile fields in sync
 * afterwards.
 */
export async function ensureUserAndHousehold(
  user: User,
): Promise<{ profile: UserProfile; household: Household }> {
  const userRef = doc(db, 'users', user.uid)
  const snapshot = await getDoc(userRef)

  const stored = snapshot.exists() ? toProfile(user.uid, snapshot.data()) : null

  // A name already saved here wins: it may have been edited in the app, and
  // an email/password user has no displayName on the auth record to restore
  // it from. Only fall back to the address when nothing is stored yet.
  const identity = {
    displayName: stored?.displayName ?? user.displayName ?? nameFromEmail(user.email),
    email: user.email,
    photoURL: stored?.photoURL ?? user.photoURL,
  }

  if (stored) {
    const existing = stored

    const stale =
      existing.displayName !== identity.displayName ||
      existing.email !== identity.email ||
      existing.photoURL !== identity.photoURL
    if (stale) await updateDoc(userRef, identity)

    const householdId = existing.defaultHouseholdId ?? existing.householdIds[0] ?? null
    if (householdId) {
      try {
        const householdSnapshot = await getDoc(doc(db, 'households', householdId))
        if (householdSnapshot.exists()) {
          return {
            profile: { ...existing, ...identity },
            household: toHousehold(householdSnapshot.id, householdSnapshot.data()),
          }
        }
      } catch {
        // Lost access — e.g. removed from the household by its owner. Fall
        // through and land this user in a fresh solo kitchen rather than an
        // error screen; their profile's household list is rewritten below.
      }
    }
    // Profile exists but its household is gone or unreadable — make a fresh one.
  }

  // The rules require ownerUid == uid and memberUids == [uid] at creation,
  // so a new household always starts as a household of one.
  const householdRef = doc(db, 'households', `hh_${user.uid.slice(0, 12)}`)
  const householdData = {
    name: defaultHouseholdName(identity.displayName),
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

/**
 * Load the profiles for a set of uids (household members and friends), so the
 * Settings screen can show who's in the kitchen by name. Reading another
 * user's profile is allowed for any signed-in user (see firestore.rules); a
 * uid with no profile doc yet falls back to a placeholder.
 */
export async function fetchProfiles(uids: string[]): Promise<UserProfile[]> {
  const snapshots = await Promise.all(uids.map((uid) => getDoc(doc(db, 'users', uid))))
  return snapshots.map((snapshot, index) =>
    snapshot.exists()
      ? toProfile(snapshot.id, snapshot.data())
      : {
          uid: uids[index],
          displayName: null,
          email: null,
          photoURL: null,
          householdIds: [],
          defaultHouseholdId: null,
          pendingInvite: null,
        },
  )
}

/**
 * Set the current user's screen name. It's stored on their profile and, once
 * set, wins over the email-derived fallback on every future sign-in (see
 * ensureUserAndHousehold). An empty name clears it, falling back to the
 * derived one. Members see this name in the recipe byline and the roster.
 */
export async function setDisplayName(uid: string, name: string): Promise<void> {
  const trimmed = name.trim()
  await updateDoc(doc(db, 'users', uid), { displayName: trimmed || null })
}

/**
 * Rename the household. Any member may do this; the rules allow a member to
 * update the household as long as ownership is unchanged (we only touch name).
 */
export async function setHouseholdName(householdId: string, name: string): Promise<void> {
  const trimmed = name.trim()
  if (!trimmed) return
  await updateDoc(doc(db, 'households', householdId), { name: trimmed })
}

/**
 * Load the households a user belongs to, for the kitchen switcher. Reading a
 * household is allowed for its members and friends (firestore.rules); a doc that
 * can't be read (e.g. you were removed, but your profile still lists it) is
 * skipped rather than failing the whole list.
 */
export async function fetchHouseholds(ids: string[]): Promise<Household[]> {
  const snaps = await Promise.all(
    ids.map((id) => getDoc(doc(db, 'households', id)).catch(() => null)),
  )
  const out: Household[] = []
  for (const snap of snaps) {
    if (snap && snap.exists()) out.push(toHousehold(snap.id, snap.data()))
  }
  return out
}

/**
 * Create a brand-new kitchen owned by this user — a private one, or another
 * shared one to invite people into — and make it the active kitchen. The rules
 * require ownerUid == uid and memberUids == [uid] at creation.
 */
export async function createHousehold(uid: string, name: string): Promise<string> {
  const ref = doc(collection(db, 'households'))
  await setDoc(ref, {
    name: name.trim() || 'New Kitchen',
    ownerUid: uid,
    memberUids: [uid],
    friendUids: [],
    createdAt: serverTimestamp(),
  })
  await updateDoc(doc(db, 'users', uid), {
    householdIds: arrayUnion(ref.id),
    defaultHouseholdId: ref.id,
  })
  return ref.id
}

/** Point the app at a different kitchen the user already belongs to. */
export async function switchHousehold(uid: string, householdId: string): Promise<void> {
  await updateDoc(doc(db, 'users', uid), { defaultHouseholdId: householdId })
}

/*
 * Member & role management. The rules (firestore.rules) are the real boundary:
 *  - removing/demoting a member and promoting a friend are OWNER-only,
 *  - removing a friend is allowed for any member,
 *  - the owner can never be removed or demoted,
 *  - anyone but the owner can remove only themselves (leave).
 * The client mirrors those so the UI only offers what will actually succeed.
 */

/** Owner-only: remove a member from the household. */
export async function removeMember(householdId: string, uid: string): Promise<void> {
  await updateDoc(doc(db, 'households', householdId), { memberUids: arrayRemove(uid) })
}

/** Any member: drop a read-only friend (guest). */
export async function removeFriend(householdId: string, uid: string): Promise<void> {
  await updateDoc(doc(db, 'households', householdId), { friendUids: arrayRemove(uid) })
}

/** Owner-only: promote a friend to full member. */
export async function promoteToMember(householdId: string, uid: string): Promise<void> {
  await updateDoc(doc(db, 'households', householdId), {
    memberUids: arrayUnion(uid),
    friendUids: arrayRemove(uid),
  })
}

/** Owner-only: demote a member to a read-only friend. */
export async function demoteToFriend(householdId: string, uid: string): Promise<void> {
  await updateDoc(doc(db, 'households', householdId), {
    memberUids: arrayRemove(uid),
    friendUids: arrayUnion(uid),
  })
}

/**
 * Leave the kitchen — remove only yourself. `role` picks the array to leave from
 * so the write touches exactly one (the rules require that). The owner can't
 * leave; the UI never offers it to them.
 */
export async function leaveHousehold(
  householdId: string,
  uid: string,
  role: 'member' | 'friend',
): Promise<void> {
  const key = role === 'friend' ? 'friendUids' : 'memberUids'
  await updateDoc(doc(db, 'households', householdId), { [key]: arrayRemove(uid) })
  // Detach it from your own profile so the next load doesn't try to reopen a
  // kitchen you can no longer read; ensureUserAndHousehold then lands you in
  // another of your kitchens, or a fresh solo one.
  await updateDoc(doc(db, 'users', uid), {
    householdIds: arrayRemove(householdId),
    defaultHouseholdId: null,
  })
}
