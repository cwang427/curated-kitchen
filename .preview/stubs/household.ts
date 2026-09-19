import type { UserProfile } from '../../src/lib/types'

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
