import {
  arrayUnion,
  deleteDoc,
  doc,
  getDoc,
  serverTimestamp,
  setDoc,
  updateDoc,
} from 'firebase/firestore'
import { db } from '../lib/firebase'
import type { HouseholdRole, Invite } from '../lib/types'

/**
 * Joining a household by code, and minting/revoking the codes.
 *
 * The security rules (firestore.rules) enforce that redeeming an invite can
 * only ever add the caller — and no one else — to the household the invite
 * names. The client steps below are written to match what those rules verify;
 * changing one without the other will produce permission-denied errors.
 */

/** A URL-safe, unguessable code. 160 bits of randomness is plenty. */
function generateCode(): string {
  const bytes = new Uint8Array(20)
  crypto.getRandomValues(bytes)
  // base64url without padding.
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
}

export class InviteError extends Error {}

/**
 * Mint an invite for a household. Only a member may call this (the rules
 * enforce it). The code is also stored on the household so both members can
 * see and re-share the current one.
 */
export async function createInvite(
  householdId: string,
  householdName: string,
  createdBy: string,
  role: HouseholdRole,
): Promise<string> {
  const code = generateCode()

  await setDoc(doc(db, 'invites', code), {
    householdId,
    householdName,
    role,
    createdBy,
    createdAt: serverTimestamp(),
  })

  // Best-effort convenience field; the invite doc above is the source of truth.
  await updateDoc(doc(db, 'households', householdId), { inviteCode: code })

  return code
}

export async function revokeInvite(householdId: string, code: string): Promise<void> {
  await deleteDoc(doc(db, 'invites', code))
  const snapshot = await getDoc(doc(db, 'households', householdId))
  if (snapshot.exists() && snapshot.data().inviteCode === code) {
    await updateDoc(doc(db, 'households', householdId), { inviteCode: null })
  }
}

async function readInvite(code: string): Promise<Invite> {
  const snapshot = await getDoc(doc(db, 'invites', code))
  if (!snapshot.exists()) {
    throw new InviteError(
      'That invite code is not valid — it may have been revoked. Ask for a fresh one.',
    )
  }
  const data = snapshot.data()
  return {
    code,
    householdId: data.householdId,
    role: data.role === 'friend' ? 'friend' : 'member',
    householdName: data.householdName ?? null,
  } as Invite
}

/**
 * Redeem an invite, adding the current user to the household it names.
 * The three writes mirror the rules exactly:
 *  1. stage the code on the user's own profile (so the rule can verify it),
 *  2. add self to the household's member or friend list,
 *  3. record the new household on the profile and clear the staged code.
 */
export async function joinByCode(
  code: string,
  uid: string,
): Promise<{ householdId: string; role: HouseholdRole }> {
  const trimmed = code.trim()
  if (!trimmed) throw new InviteError('Enter an invite code first.')

  const invite = await readInvite(trimmed)

  if (invite.householdId === `hh_${uid.slice(0, 12)}`) {
    throw new InviteError('That’s an invite to your own kitchen.')
  }

  const userRef = doc(db, 'users', uid)
  await setDoc(userRef, { pendingInvite: trimmed }, { merge: true })

  const householdRef = doc(db, 'households', invite.householdId)
  try {
    await updateDoc(householdRef, {
      [invite.role === 'friend' ? 'friendUids' : 'memberUids']: arrayUnion(uid),
    })
  } catch (cause) {
    // Leaving a stale pendingInvite around would block nothing, but clearing
    // it keeps the profile honest if the join failed (e.g. revoked mid-flight).
    await updateDoc(userRef, { pendingInvite: null }).catch(() => {})
    throw cause
  }

  await updateDoc(userRef, {
    householdIds: arrayUnion(invite.householdId),
    defaultHouseholdId: invite.householdId,
    pendingInvite: null,
  })

  return { householdId: invite.householdId, role: invite.role }
}

/** Point the user's app at a different household they already belong to. */
export async function switchHousehold(uid: string, householdId: string): Promise<void> {
  await updateDoc(doc(db, 'users', uid), { defaultHouseholdId: householdId })
}

/** Build a shareable link that pre-fills the code on open. */
export function inviteLink(code: string): string {
  const base = `${window.location.origin}${import.meta.env.BASE_URL}`
  return `${base}?join=${encodeURIComponent(code)}`
}
