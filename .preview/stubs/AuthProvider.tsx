import type { ReactNode } from 'react'

export function AuthProvider({ children }: { children: ReactNode }) {
  return <>{children}</>
}

export function useAuth() {
  return {
    user: { displayName: 'Cassidy', email: 'c@example.com', photoURL: null },
    profile: null,
    household: { id: 'hh_preview', name: 'Cassidy’s Kitchen', ownerUid: 'u', memberUids: ['u'], friendUids: [], createdAt: null },
    loading: false,
    error: null,
    signIn: async () => {},
    signOut: async () => {},
  } as never
}
