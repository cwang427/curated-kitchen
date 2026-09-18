import { useEffect, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { doc, getDoc } from 'firebase/firestore'
import { db } from '../lib/firebase'
import { useAuth } from '../auth/AuthProvider'
import { InviteError, joinByCode } from '../data/invites'
import { describeFirestoreError } from '../lib/errors'
import type { HouseholdRole } from '../lib/types'

type State =
  | { status: 'loading' }
  | { status: 'ready'; householdName: string; role: HouseholdRole }
  | { status: 'joining' }
  | { status: 'error'; message: string }

/**
 * Opened via an invite link (?join=<code>). Reads the invite, names the
 * kitchen, and lets the signed-in user accept. The heavy lifting — and all
 * the security — is in joinByCode and the rules; this is just the prompt.
 */
export default function JoinPage() {
  const { user, refresh } = useAuth()
  const [params] = useSearchParams()
  const navigate = useNavigate()
  const code = params.get('join') ?? ''

  const [state, setState] = useState<State>({ status: 'loading' })

  useEffect(() => {
    let live = true
    ;(async () => {
      if (!code) {
        setState({ status: 'error', message: 'This link is missing its invite code.' })
        return
      }
      try {
        const snapshot = await getDoc(doc(db, 'invites', code))
        if (!live) return
        if (!snapshot.exists()) {
          setState({
            status: 'error',
            message: 'This invite is no longer valid — it may have been revoked. Ask for a fresh link.',
          })
          return
        }
        const data = snapshot.data()
        setState({
          status: 'ready',
          householdName: data.householdName ?? 'a kitchen',
          role: data.role === 'friend' ? 'friend' : 'member',
        })
      } catch {
        if (live) setState({ status: 'error', message: 'Could not load this invite. Check your connection.' })
      }
    })()
    return () => {
      live = false
    }
  }, [code])

  const accept = async () => {
    if (!user) return
    setState({ status: 'joining' })
    try {
      await joinByCode(code, user.uid)
      await refresh()
      navigate('/', { replace: true })
    } catch (cause) {
      setState({
        status: 'error',
        message:
          cause instanceof InviteError
            ? cause.message
            : describeFirestoreError(cause, 'join this kitchen'),
      })
    }
  }

  return (
    <div className="flex min-h-dvh flex-col items-center justify-center px-6 text-center">
      <div className="w-full max-w-sm space-y-6">
        {state.status === 'loading' && <p className="text-ink-faint">Checking the invite…</p>}

        {state.status === 'error' && (
          <>
            <p className="font-serif text-2xl tracking-tight">Invite problem</p>
            <p role="alert" className="text-ink-soft">
              {state.message}
            </p>
            <button
              type="button"
              onClick={() => navigate('/', { replace: true })}
              className="text-accent underline"
            >
              Go to my kitchen
            </button>
          </>
        )}

        {(state.status === 'ready' || state.status === 'joining') && (
          <>
            <div className="space-y-2">
              <p className="text-ink-soft">You’ve been invited to join</p>
              <p className="font-serif text-3xl tracking-tight">{state.status === 'ready' ? state.householdName : ''}</p>
              <p className="text-sm text-ink-faint">
                {state.status === 'ready' && state.role === 'friend'
                  ? 'As a friend — you’ll see recipes they share with you.'
                  : 'As a member — you’ll share recipes, the grocery list, and the cook log.'}
              </p>
            </div>
            <button
              type="button"
              onClick={accept}
              disabled={state.status === 'joining'}
              className="min-h-12 w-full rounded-xl bg-accent text-base font-semibold text-white transition active:scale-[0.99] disabled:opacity-50 dark:text-stone-900"
            >
              {state.status === 'joining' ? 'Joining…' : 'Join'}
            </button>
            <button
              type="button"
              onClick={() => navigate('/', { replace: true })}
              className="text-sm text-ink-faint underline"
            >
              Not now
            </button>
          </>
        )}
      </div>
    </div>
  )
}
