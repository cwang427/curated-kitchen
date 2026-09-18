import { useEffect, useState } from 'react'
import AppHeader from '../components/AppHeader'
import VersionInfo from '../components/VersionInfo'
import { useAuth } from '../auth/AuthProvider'
import { createInvite, inviteLink, listInvites, revokeInvite } from '../data/invites'
import { describeFirestoreError } from '../lib/errors'
import type { HouseholdRole } from '../lib/types'

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

  const label = role === 'member' ? 'partner' : 'friend'
  const link = code ? inviteLink(code) : null

  return (
    <div className="rounded-2xl border border-line bg-card p-4">
      <h3 className="font-medium">Invite a {label}</h3>
      <p className="mt-1 text-sm text-ink-soft">
        {role === 'member'
          ? 'They’ll share everything in this kitchen with you.'
          : 'They’ll see only the recipes you mark as shared with friends.'}
      </p>

      {!code ? (
        <button
          type="button"
          onClick={generate}
          disabled={busy}
          className="mt-3 min-h-11 rounded-full bg-accent px-4 text-sm font-semibold text-white transition active:scale-[0.98] disabled:opacity-50 dark:text-stone-900"
        >
          {busy ? 'Creating…' : `Create ${label} invite`}
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
            Send this link to your {label}. Anyone with it can join until you revoke it.
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
        <section className="space-y-3">
          <h2 className="font-serif text-xl tracking-tight">{household.name}</h2>
          <p className="text-sm text-ink-soft">
            {memberCount} {memberCount === 1 ? 'member' : 'members'}
            {friendCount > 0 && `, ${friendCount} ${friendCount === 1 ? 'friend' : 'friends'}`}
            {youAreMember ? '' : ' · you’re a friend here'}
          </p>
        </section>

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
