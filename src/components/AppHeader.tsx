import { Link } from 'react-router-dom'
import { useAuth } from '../auth/AuthProvider'

interface Props {
  title?: string
  /** Show a back chevron that returns to the recipe list. */
  back?: boolean
}

export default function AppHeader({ title, back }: Props) {
  const { user, household } = useAuth()

  return (
    <header className="pad-safe-top sticky top-0 z-20 border-b border-line bg-paper/90 backdrop-blur">
      <div className="mx-auto flex max-w-3xl items-center justify-between gap-3 px-4 pb-3">
        <div className="flex min-w-0 items-center gap-2">
          {back && (
            <Link
              to="/"
              aria-label="Back to recipes"
              className="-ml-1 grid size-9 shrink-0 place-items-center rounded-full text-ink-soft transition active:bg-line"
            >
              <svg viewBox="0 0 24 24" className="size-6" fill="none" aria-hidden="true">
                <path
                  d="M15 19l-7-7 7-7"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </Link>
          )}
          <Link to="/" className="min-w-0">
            <span className="block truncate font-serif text-xl tracking-tight">
              {title ?? 'Curated Kitchen'}
            </span>
            {household && !title && (
              <span className="block truncate text-xs text-ink-faint">{household.name}</span>
            )}
          </Link>
        </div>

        <Link
          to="/settings"
          title="Settings"
          aria-label="Settings"
          className="shrink-0 rounded-full border border-line"
        >
          {user?.photoURL ? (
            <img
              src={user.photoURL}
              alt=""
              referrerPolicy="no-referrer"
              className="size-9 rounded-full"
            />
          ) : (
            <span className="grid size-9 place-items-center rounded-full bg-accent-soft text-sm font-semibold text-accent">
              {(user?.displayName ?? user?.email ?? '?').slice(0, 1).toUpperCase()}
            </span>
          )}
        </Link>
      </div>
    </header>
  )
}
