import type { HouseholdRole } from '../../src/lib/types'

let counter = 0
export class InviteError extends Error {}

export async function createInvite(
  _hid: string, _name: string, _uid: string, role: HouseholdRole,
): Promise<string> {
  await new Promise((r) => setTimeout(r, 300))
  return `${role.toUpperCase()}-demo${++counter}-abcdEF123456`
}
export async function revokeInvite(): Promise<void> {
  await new Promise((r) => setTimeout(r, 200))
}
export async function joinByCode(): Promise<{ householdId: string; role: HouseholdRole }> {
  return { householdId: 'hh_demo', role: 'member' }
}
export async function switchHousehold(): Promise<void> {}
export function inviteLink(code: string): string {
  return `https://cwang427.github.io/curated-kitchen/?join=${code}`
}
