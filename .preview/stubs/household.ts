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
