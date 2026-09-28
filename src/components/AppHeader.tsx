import { useLayoutEffect, useRef } from 'react'
import { useAuth } from '../auth/AuthProvider'
import { Link, useAppNav } from './nav'
import { useReviewRecipes } from '../data/recipes'

interface Props {
  title?: string
  /** Show a back chevron to this screen's parent (a recipe → the kitchen, cook
   * mode → its recipe; see components/nav.tsx) — the same place a swipe goes. */
  back?: boolean
  /** Override for screens with their own inner steps (Add a recipe's import
   * screens). */
  onBack?: () => void
  /** Show the "add a recipe" shortcut (members only). */
  add?: boolean
  /** Show the meal-plan (calendar) shortcut. */
  plan?: boolean
  /** Show the grocery-list (cart) shortcut. */
  cart?: boolean
}

export default function AppHeader({ title, back, onBack, add, plan, cart }: Props) {
  const { user, profile, household } = useAuth()
  // Email/password accounts carry no auth displayName, so prefer the profile's.
  const displayName = profile?.displayName ?? user?.displayName ?? user?.email ?? '?'
  // Members only: adding recipes, the meal plan, and the grocery list are all
  // member actions — a guest (friend) can't read or write them, so hide the
  // shortcuts rather than offer a tap that errors.
  const isMember = !!user && !!household && household.memberUids.includes(user.uid)
  const canAdd = add && isMember
  // Imports waiting for someone to look them over, counted on the "+".
  const waiting = useReviewRecipes().recipes.length
  const { goUp } = useAppNav()
  const backClass =
    '-ml-1 grid size-9 shrink-0 place-items-center rounded-full text-ink-soft transition active:bg-line'

  // Publish the header's real height as --app-header-h, so bars that stick
  // below it (the recipe page's scale bar) sit right under it. It isn't a fixed
  // number: on an installed iPhone app the top clearance makes it ~150px.
  const ref = useRef<HTMLElement>(null)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const publish = () => document.documentElement.style.setProperty('--app-header-h', `${el.offsetHeight}px`)
    publish()
    const observer = new ResizeObserver(publish)
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  return (
    // Sticky: the header (with its shortcuts) stays at the top while you scroll.
    <header ref={ref} className="pad-safe-top sticky top-0 z-20 border-b border-line bg-paper">
      <div className="mx-auto flex max-w-3xl items-center justify-between gap-3 px-4 pb-3">
        <div className="flex min-w-0 items-center gap-2">
          {back && (
            <button type="button" onClick={onBack ?? goUp} aria-label="Back" className={backClass}>
              <BackChevron />
            </button>
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

        <div className="flex shrink-0 items-center gap-2">
        {canAdd && (
          <Link
            to="/add"
            title="Add a recipe"
            aria-label={waiting ? `Add a recipe — ${waiting} awaiting review` : 'Add a recipe'}
            className="relative grid size-9 place-items-center rounded-full border border-line text-ink-soft transition active:bg-line"
          >
            <svg viewBox="0 0 24 24" className="size-5" fill="none" aria-hidden="true">
              <path d="M12 5v14M5 12h14" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            </svg>
            {waiting > 0 && (
              <span
                aria-hidden
                className="absolute -right-1.5 -top-1.5 grid h-5 min-w-5 place-items-center rounded-full bg-accent px-1 text-xs font-semibold text-white dark:text-stone-900"
              >
                {waiting}
              </span>
            )}
          </Link>
        )}
        {plan && isMember && (
          <Link
            to="/plan"
            title="Meal plan"
            aria-label="Meal plan"
            className="grid size-9 place-items-center rounded-full border border-line text-ink-soft transition active:bg-line"
          >
            <svg viewBox="0 0 24 24" className="size-5" fill="none" aria-hidden="true">
              <rect x="4" y="5" width="16" height="15" rx="2" stroke="currentColor" strokeWidth="1.8" />
              <path d="M4 9h16M8 3v4M16 3v4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
            </svg>
          </Link>
        )}
        {cart && isMember && (
          <Link
            to="/list"
            title="Grocery list"
            aria-label="Grocery list"
            className="grid size-9 place-items-center rounded-full border border-line text-ink-soft transition active:bg-line"
          >
            <svg viewBox="0 0 24 24" className="size-5" fill="none" aria-hidden="true">
              <path
                d="M4 5h2l1.5 10.5A2 2 0 0 0 9.5 17h7a2 2 0 0 0 2-1.6L20 8H7"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
              <circle cx="10" cy="20" r="1.2" fill="currentColor" />
              <circle cx="17" cy="20" r="1.2" fill="currentColor" />
            </svg>
          </Link>
        )}
        <Link
          to="/settings"
          title="Settings"
          aria-label="Settings"
          className="rounded-full border border-line"
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
              {displayName.slice(0, 1).toUpperCase()}
            </span>
          )}
        </Link>
        </div>
      </div>
    </header>
  )
}

function BackChevron() {
  return (
    <svg viewBox="0 0 24 24" className="size-6" fill="none" aria-hidden="true">
      <path d="M15 19l-7-7 7-7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}
