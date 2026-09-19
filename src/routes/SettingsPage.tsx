import { useEffect, useState } from 'react'
import AppHeader from '../components/AppHeader'
import VersionInfo from '../components/VersionInfo'
import { useAuth } from '../auth/AuthProvider'
import { fetchProfiles } from '../data/household'
import { createInvite, inviteLink, listInvites, revokeInvite } from '../data/invites'
import { describeFirestoreError } from '../lib/errors'
import type { HouseholdRole, UserProfile } from '../lib/types'

function displayNameFor(profile: UserProfile): string {
  return profile.displayName ?? profile.email ?? `${profile.uid.slice(0, 6)}…`
}

/** Who's in the kitchen, by name, with you and the owner marked. */
function PeopleList() {
  const { user, household } = useAuth()
  const [profiles, setProfiles] = useState<Map<string, UserProfile>>(new Map())

  const memberUids = household?.memberUids ?? []
  const friendUids = household?.friendUids ?? []
  // Stable dependency key so the effect only refetches when the roster changes.
  const rosterKey = [...memberUids, ...friendUids].sort().join(',')

  useEffect(() => {
    if (!rosterKey) return
    let live = true
    fetchProfiles(rosterKey.split(','))
      .then((loaded) => {
        if (live) setProfiles(new Map(loaded.map((p) => [p.uid, p])))
      })
      .catch(() => {
        // Non-fatal — fall back to the uid-based placeholder below.
      })
    return () => {
      live = false
    }
  }, [rosterKey])

  if (!user || !household) return null

  const row = (uid: string, tag: 'member' | 'friend') => {
    const profile =
      profiles.get(uid) ??
      ({ uid, displayName: null, email: null, photoURL: null, householdIds: [], defaultHouseholdId: null, pendingInvite: null } as UserProfile)
    const badges = [
      uid === user.uid ? 'you' : null,
      uid === household.ownerUid ? 'owner' : null,
      tag === 'friend' ? 'friend' : null,
    ].filter(Boolean) as string[]

    return (
      <li key={uid} className="flex min-h-11 items-center gap-3 py-1">
        <span className="grid size-9 shrink-0 place-items-center rounded-full bg-accent-soft text-sm font-semibold text-accent">
          {displayNameFor(profile).slice(0, 1).toUpperCase()}
        </span>
        <span className="min-w-0 flex-1 truncate">{displayNameFor(profile)}</span>
        {badges.map((b) => (
          <span key={b} className="shrink-0 rounded-full bg-paper px-2 py-0.5 text-xs text-ink-faint">
            {b}
          </span>
        ))}
      </li>
    )
  }

  return (
    <section>
      <h3 className="mb-1 text-sm font-semibold uppercase tracking-wide text-ink-faint">
        In this kitchen
      </h3>
      <ul>
        {memberUids.map((uid) => row(uid, 'member'))}
        {friendUids.map((uid) => row(uid, 'friend'))}
      </ul>
    </section>
  )
}

function useCopied() {
  const [copied, setCopied] = useState(false)
  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      setTimeout(() => setCopied(false), 1800)
    } catch {
      // Clipboard can be blocked; the code stays visible to copy by hand.
    }
  }
  return { copied, copy }
}

function InvitePanel({ role }: { role: HouseholdRole }) {
  const { user, household, refresh } = useAuth()
  const { copied, copy } = useCopied()
  const [code, setCode] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const householdId = household?.id
  const isMember = !!user && !!household && household.memberUids.includes(user.uid)

  // Show the link again after a reopen: an invite lives in Firestore, not just
  // in this component's state, so look up any outstanding one on mount.
  useEffect(() => {
    if (!householdId || !isMember) return
    let live = true
    listInvites(householdId, role)
      .then((invites) => {
        if (live && invites.length > 0) setCode(invites[0].code)
      })
      .catch(() => {
        // Non-fatal — the panel just falls back to the "Create" button.
      })
    return () => {
      live = false
    }
  }, [householdId, role, isMember])

  if (!user || !household || !isMember) return null

  const generate = async () => {
    setBusy(true)
    setError(null)
    try {
      // Retire any earlier links of this role so live invites don't pile up.
      const existing = await listInvites(household.id, role)
      await Promise.all(existing.map((invite) => revokeInvite(household.id, invite.code)))

      const next = await createInvite(household.id, household.name, user.uid, role)
      setCode(next)
      await refresh()
    } catch (cause) {
      setError(describeFirestoreError(cause, 'create an invite'))
    } finally {
      setBusy(false)
    }
  }

  const revoke = async () => {
    if (!code) return
    setBusy(true)
    setError(null)
    try {
      await revokeInvite(household.id, code)
      setCode(null)
      await refresh()
    } catch (cause) {
      setError(describeFirestoreError(cause, 'revoke the invite'))
    } finally {
      setBusy(false)
    }
  }

  const link = code ? inviteLink(code) : null

  return (
    <div className="rounded-2xl border border-line bg-card p-4">
      <h3 className="font-medium">Invite a {role}</h3>
      <p className="mt-1 text-sm text-ink-soft">
        {role === 'member'
          ? 'A member shares everything in this kitchen — recipes, the grocery list, and the cook log. You can add as many as you like.'
          : 'A friend only sees the recipes you mark as shared with friends — never the grocery list.'}
      </p>

      {!code ? (
        <button
          type="button"
          onClick={generate}
          disabled={busy}
          className="mt-3 min-h-11 rounded-full bg-accent px-4 text-sm font-semibold text-white transition active:scale-[0.98] disabled:opacity-50 dark:text-stone-900"
        >
          {busy ? 'Creating…' : `Create ${role} invite`}
        </button>
      ) : (
        <div className="mt-3 space-y-2">
          <p className="break-all rounded-lg bg-paper px-3 py-2 font-mono text-xs text-ink-soft">
            {link}
          </p>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => link && copy(link)}
              className="min-h-11 rounded-full bg-accent px-4 text-sm font-semibold text-white transition active:scale-[0.98] dark:text-stone-900"
            >
              {copied ? 'Copied ✓' : 'Copy link'}
            </button>
            <button
              type="button"
              onClick={revoke}
              disabled={busy}
              className="min-h-11 rounded-full border border-line px-4 text-sm text-ink-soft transition active:scale-[0.98] disabled:opacity-50"
            >
              Revoke
            </button>
          </div>
          <p className="text-xs text-ink-faint">
            Send this link to the person you’re inviting. Anyone with it can join
            as a {role} until you revoke it.
          </p>
        </div>
      )}

      {error && (
        <p role="alert" className="mt-2 text-sm text-red-600 dark:text-red-400">
          {error}
        </p>
      )}
    </div>
  )
}

export default function SettingsPage() {
  const { user, profile, household, signOut } = useAuth()
  if (!user || !household) return null

  const youAreMember = household.memberUids.includes(user.uid)
  const memberCount = household.memberUids.length
  const friendCount = household.friendUids.length

  return (
    <div className="min-h-dvh">
      <AppHeader title="Settings" back />

      <main className="pad-safe-bottom mx-auto max-w-3xl space-y-6 px-4 py-5">
        <section className="space-y-1">
          <h2 className="font-serif text-xl tracking-tight">{household.name}</h2>
          <p className="text-sm text-ink-soft">
            {memberCount} {memberCount === 1 ? 'member' : 'members'}
            {friendCount > 0 && `, ${friendCount} ${friendCount === 1 ? 'friend' : 'friends'}`}
            {youAreMember ? '' : ' · you’re a friend here'}
          </p>
        </section>

        <PeopleList />

        {youAreMember && (
          <section className="space-y-3">
            <InvitePanel role="member" />
            <InvitePanel role="friend" />
          </section>
        )}

        <section className="rounded-2xl border border-line bg-card p-4">
          <h3 className="font-medium">Signed in</h3>
          <p className="mt-1 text-sm text-ink-soft">
            {profile?.displayName ?? user.email}
            {profile?.displayName && (
              <span className="block text-ink-faint">{user.email}</span>
            )}
          </p>
          <button
            type="button"
            onClick={signOut}
            className="mt-3 min-h-11 rounded-full border border-line px-4 text-sm text-ink-soft transition active:scale-[0.98]"
          >
            Sign out
          </button>
        </section>

        <VersionInfo />
      </main>
    </div>
  )
}
