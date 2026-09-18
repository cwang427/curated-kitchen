import { Link } from 'react-router-dom'
import { useAuth } from '../auth/AuthProvider'

export default function AppHeader({ title }: { title?: string }) {
  const { user, household, signOut } = useAuth()

  return (
    <header className="pad-safe-top sticky top-0 z-20 border-b border-line bg-paper/90 backdrop-blur">
      <div className="mx-auto flex max-w-3xl items-center justify-between gap-3 px-4 pb-3">
        <Link to="/" className="min-w-0">
          <span className="block truncate font-serif text-xl tracking-tight">
            {title ?? 'Curated Kitchen'}
          </span>
          {household && !title && (
            <span className="block truncate text-xs text-ink-faint">{household.name}</span>
          )}
        </Link>

        <button
          type="button"
          onClick={signOut}
          title={`Sign out of ${user?.email ?? 'this account'}`}
          className="shrink-0 rounded-full border border-line"
        >
          {user?.photoURL ? (
            <img
              src={user.photoURL}
              alt="Sign out"
              referrerPolicy="no-referrer"
              className="size-9 rounded-full"
            />
          ) : (
            <span className="grid size-9 place-items-center rounded-full bg-accent-soft text-sm font-semibold text-accent">
              {(user?.displayName ?? user?.email ?? '?').slice(0, 1).toUpperCase()}
            </span>
          )}
        </button>
      </div>
    </header>
  )
}
