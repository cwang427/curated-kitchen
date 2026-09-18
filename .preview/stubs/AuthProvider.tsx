import { useState, type ReactNode } from 'react'

export function AuthProvider({ children }: { children: ReactNode }) {
  return <>{children}</>
}

/**
 * Add ?signedout to the preview URL to render the sign-in screen instead of
 * the app. Errors can be previewed with ?signedout&error.
 */
export function useAuth() {
  const params = new URLSearchParams(window.location.search)
  const signedOut = params.has('signedout')
  const [submitting, setSubmitting] = useState(false)

  return {
    user: signedOut ? null : { displayName: 'Cassidy', email: 'c@example.com', photoURL: null },
    profile: null,
    household: signedOut
      ? null
      : { id: 'hh_preview', name: 'Cassidy’s Kitchen', ownerUid: 'u', memberUids: ['u'], friendUids: [], createdAt: null },
    loading: false,
    submitting,
    error: params.has('error') ? 'That email and password don’t match an account.' : null,
    signIn: async () => {
      setSubmitting(true)
      setTimeout(() => setSubmitting(false), 900)
    },
    signOut: async () => {},
  } as never
}
