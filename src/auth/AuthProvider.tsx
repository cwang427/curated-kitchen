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
  signInWithPopup,
  signInWithRedirect,
  signOut as firebaseSignOut,
  type User,
} from 'firebase/auth'
import { auth, googleProvider } from '../lib/firebase'
import { ensureUserAndHousehold } from '../data/household'
import type { Household, UserProfile } from '../lib/types'

interface AuthState {
  user: User | null
  profile: UserProfile | null
  household: Household | null
  loading: boolean
  error: string | null
  signIn: () => Promise<void>
  signOut: () => Promise<void>
}

const AuthContext = createContext<AuthState | null>(null)

/**
 * Popups are blocked inside an iOS home-screen PWA, so fall back to a
 * redirect there. Detecting the display mode is more reliable than sniffing
 * the user agent.
 */
function prefersRedirect(): boolean {
  return (
    window.matchMedia('(display-mode: standalone)').matches ||
    // iOS Safari's non-standard flag for home-screen apps.
    (window.navigator as { standalone?: boolean }).standalone === true
  )
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null)
  const [profile, setProfile] = useState<UserProfile | null>(null)
  const [household, setHousehold] = useState<Household | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    return onAuthStateChanged(auth, async (nextUser) => {
      setUser(nextUser)
      setError(null)

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
      } catch (cause) {
        setError(
          cause instanceof Error
            ? cause.message
            : 'Could not load your kitchen. Check your connection and try again.',
        )
      } finally {
        setLoading(false)
      }
    })
  }, [])

  const signIn = useCallback(async () => {
    setError(null)
    try {
      if (prefersRedirect()) {
        await signInWithRedirect(auth, googleProvider)
        return
      }
      await signInWithPopup(auth, googleProvider)
    } catch (cause) {
      const code = (cause as { code?: string }).code
      // The user closing the popup is not worth an error message.
      if (code === 'auth/popup-closed-by-user' || code === 'auth/cancelled-popup-request') {
        return
      }
      if (code === 'auth/popup-blocked') {
        await signInWithRedirect(auth, googleProvider)
        return
      }
      setError(cause instanceof Error ? cause.message : 'Sign-in failed.')
    }
  }, [])

  const signOut = useCallback(async () => {
    await firebaseSignOut(auth)
  }, [])

  const value = useMemo<AuthState>(
    () => ({ user, profile, household, loading, error, signIn, signOut }),
    [user, profile, household, loading, error, signIn, signOut],
  )

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth(): AuthState {
  const context = useContext(AuthContext)
  if (!context) throw new Error('useAuth must be used inside an AuthProvider')
  return context
}
