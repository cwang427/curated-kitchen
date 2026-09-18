import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react'
import {
  onAuthStateChanged,
  signInWithEmailAndPassword,
  signOut as firebaseSignOut,
  type User,
} from 'firebase/auth'
import { auth } from '../lib/firebase'
import { ensureUserAndHousehold } from '../data/household'
import { describeFirestoreError } from '../lib/errors'
import type { Household, UserProfile } from '../lib/types'

interface AuthState {
  user: User | null
  profile: UserProfile | null
  household: Household | null
  loading: boolean
  /** True while a sign-in attempt is in flight. */
  submitting: boolean
  error: string | null
  signIn: (email: string, password: string) => Promise<void>
  signOut: () => Promise<void>
  /** Re-read the profile and active household — after a join or a switch. */
  refresh: () => Promise<void>
}

const AuthContext = createContext<AuthState | null>(null)

/**
 * Firebase's codes are accurate but unhelpful at 7am. Note that recent
 * versions collapse "wrong password" and "no such user" into
 * invalid-credential on purpose, so an attacker can't probe for which
 * addresses exist — the message here has to cover both.
 */
function describeAuthError(code: string | undefined, fallback: string): string {
  switch (code) {
    case 'auth/invalid-credential':
    case 'auth/wrong-password':
    case 'auth/user-not-found':
      return 'That email and password don’t match an account.'
    case 'auth/invalid-email':
      return 'That doesn’t look like an email address.'
    case 'auth/user-disabled':
      return 'That account has been disabled.'
    case 'auth/too-many-requests':
      return 'Too many attempts. Wait a minute and try again.'
    case 'auth/network-request-failed':
      return 'Can’t reach Firebase — check your connection.'
    case 'auth/operation-not-allowed':
      return 'Email/password sign-in isn’t enabled for this Firebase project.'
    default:
      return fallback
  }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null)
  const [profile, setProfile] = useState<UserProfile | null>(null)
  const [household, setHousehold] = useState<Household | null>(null)
  const [loading, setLoading] = useState(true)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    return onAuthStateChanged(auth, async (nextUser) => {
      setUser(nextUser)

      if (!nextUser) {
        setProfile(null)
        setHousehold(null)
        setLoading(false)
        return
      }

      try {
        const result = await ensureUserAndHousehold(nextUser)
        setProfile(result.profile)
        setHousehold(result.household)
        setError(null)
      } catch (cause) {
        // A permission error here almost always means firestore.rules hasn't
        // been published yet; describeFirestoreError says exactly that.
        setError(describeFirestoreError(cause, 'load your kitchen'))
      } finally {
        setLoading(false)
      }
    })
  }, [])

  const signIn = useCallback(async (email: string, password: string) => {
    setError(null)
    setSubmitting(true)
    try {
      await signInWithEmailAndPassword(auth, email.trim(), password)
      // onAuthStateChanged takes it from here.
    } catch (cause) {
      setError(
        describeAuthError((cause as { code?: string }).code, 'Sign-in failed. Try again.'),
      )
    } finally {
      setSubmitting(false)
    }
  }, [])

  const signOut = useCallback(async () => {
    setError(null)
    await firebaseSignOut(auth)
  }, [])

  const refresh = useCallback(async () => {
    if (!auth.currentUser) return
    const result = await ensureUserAndHousehold(auth.currentUser)
    setProfile(result.profile)
    setHousehold(result.household)
  }, [])

  const value = useMemo<AuthState>(
    () => ({ user, profile, household, loading, submitting, error, signIn, signOut, refresh }),
    [user, profile, household, loading, submitting, error, signIn, signOut, refresh],
  )

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth(): AuthState {
  const context = useContext(AuthContext)
  if (!context) throw new Error('useAuth must be used inside an AuthProvider')
  return context
}
