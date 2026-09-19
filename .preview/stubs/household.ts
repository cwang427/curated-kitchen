import type { Household, UserProfile } from '../../src/lib/types'

const NAMES: Record<string, string> = {
  u: 'Cassidy',
  partner_uid: 'Jordan',
  friend_uid: 'Sam',
}

export async function fetchProfiles(uids: string[]): Promise<UserProfile[]> {
  return uids.map((uid) => ({
    uid,
    displayName: NAMES[uid] ?? null,
    email: `${uid}@example.com`,
    photoURL: null,
    householdIds: [],
    defaultHouseholdId: null,
    pendingInvite: null,
  }))
}

export async function setDisplayName(): Promise<void> {
  await new Promise((r) => setTimeout(r, 200))
}

export async function setHouseholdName(): Promise<void> {
  await new Promise((r) => setTimeout(r, 200))
}

export async function removeMember(): Promise<void> {}
export async function removeFriend(): Promise<void> {}
export async function promoteToMember(): Promise<void> {}
export async function demoteToFriend(): Promise<void> {}
export async function leaveHousehold(): Promise<void> {}

export async function fetchHouseholds(): Promise<Household[]> {
  // Mirror the ?asfriend view: 'u' is a guest of the shared kitchen, a member
  // only of their own "Weeknight Solo".
  const asFriend = new URLSearchParams(window.location.search).has('asfriend')
  return [
    asFriend
      ? { id: 'hh_preview', name: 'The Shared Kitchen', ownerUid: 'partner_uid', memberUids: ['partner_uid'], friendUids: ['u'], inviteCode: null, createdAt: null }
      : { id: 'hh_preview', name: 'Cassidy’s Kitchen', ownerUid: 'u', memberUids: ['u', 'partner_uid'], friendUids: ['friend_uid'], inviteCode: null, createdAt: null },
    { id: 'hh_personal', name: 'Weeknight Solo', ownerUid: 'u', memberUids: ['u'], friendUids: [], inviteCode: null, createdAt: null },
  ]
}
export async function createHousehold(): Promise<string> {
  return 'hh_new'
}
export async function switchHousehold(): Promise<void> {}
