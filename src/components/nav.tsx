import { useCallback, useEffect, useLayoutEffect, useRef, type AnchorHTMLAttributes } from 'react'
import { useHref, useLocation, useNavigate, useNavigationType } from 'react-router-dom'

/**
 * Navigation follows a fixed hierarchy, not "wherever you came from":
 *
 *   kitchen (/) ← recipe (/r/x) ← cook mode (/r/x/cook) · editor (/r/x/edit)
 *   kitchen ← Add a recipe (/add) ← its import screens (/add?m=…)
 *   kitchen ← Add a recipe ← an import awaiting review (/review/x) ← its editor
 *   kitchen ← grocery list · cooking timeline · settings
 *
 * Back always goes to the parent. An installed iPhone web app's edge-swipe
 * can't be turned off and always steps back one history entry, so the app keeps
 * browser history shaped exactly like that chain: underneath any screen sit its
 * ancestors and nothing else (goTo), and the swipe and ‹ always agree.
 */
export function parentOf(path: string): string | null {
  const [pathname, search = ''] = path.split('?')
  if (pathname === '/') return null
  const child = pathname.match(/^\/r\/([^/]+)\/(cook|edit)$/)
  if (child) return `/r/${child[1]}`
  if (pathname === '/add' && new URLSearchParams(search).get('m')) return '/add'
  const review = pathname.match(/^\/review\/([^/]+)(\/edit)?$/)
  if (review) return review[2] ? `/review/${review[1]}` : '/add'
  return '/'
}

/** The screen and its ancestors, kitchen first. */
export function chainOf(path: string): string[] {
  const chain = [path]
  for (let p = parentOf(path); p; p = parentOf(p)) chain.unshift(p)
  return chain
}

/** How many in-app entries sit behind this one. React Router's BrowserRouter
 * stamps each history entry it creates with an index; 0 = the first entry. */
export function historyDepth(): number {
  return (window.history.state as { idx?: number } | null)?.idx ?? 0
}

// A goTo that must first step back (cooking timeline → a recipe: back to the
// kitchen, then open the recipe) finishes once the browser has landed; see HistoryChain.
let pending: { at: string; push: string[] } | null = null

export function useAppNav(): { goTo: (target: string) => void; goUp: () => void } {
  const navigate = useNavigate()
  const location = useLocation()
  const here = location.pathname + location.search

  /** Open `target` with exactly its ancestors underneath it in history. */
  const goTo = useCallback(
    (target: string) => {
      const cur = chainOf(here)
      const next = chainOf(target)
      let shared = 0
      while (shared < cur.length && shared < next.length && cur[shared] === next[shared]) shared++
      const toPush = next.slice(shared)
      // Steps back to the deepest screen both chains share. Going down from
      // here needs none; back to the kitchen is the whole depth (Add a recipe's
      // editor can sit on an extra entry — its import screen).
      const back = shared === cur.length ? 0 : shared <= 1 ? historyDepth() : cur.length - shared
      if (back === 0) {
        toPush.forEach((p) => navigate(p))
      } else if (back > historyDepth()) {
        navigate(target, { replace: true }) // history isn't shaped as expected; just go
      } else {
        if (toPush.length) pending = { at: next[shared - 1], push: toPush }
        navigate(-back)
      }
    },
    [navigate, here],
  )

  /** Back to the parent screen — one history step, exactly what a swipe does. */
  const goUp = useCallback(() => {
    if (historyDepth() > 0) navigate(-1)
    else navigate(parentOf(here) ?? '/', { replace: true })
  }, [navigate, here])

  return { goTo, goUp }
}

/**
 * Keeps history shaped like the screen chain. Mount once, beside the routes.
 */
export function HistoryChain(): null {
  const navigate = useNavigate()
  const location = useLocation()
  const navType = useNavigationType()
  const here = location.pathname + location.search
  const positions = useRef(new Map<string, number>())

  // Scroll is ours, not the browser's. iOS's own restore on a history step
  // lands mid-render (a recipe shows "Loading…" before its content), which
  // left pages blank until you scrolled — tappable but unpainted.
  useEffect(() => {
    if ('scrollRestoration' in window.history) window.history.scrollRestoration = 'manual'
  }, [])

  // Remember where each history entry was scrolled to. `activeKey` switches to
  // the new entry before any scrolling for it happens, so the new page's
  // scroll-to-top (or the browser clamping a now-shorter page) can never
  // overwrite the position of the page you just left.
  const activeKey = useRef(location.key)
  useEffect(() => {
    const onScroll = () => positions.current.set(activeKey.current, window.scrollY)
    window.addEventListener('scroll', onScroll, { passive: true })
    return () => window.removeEventListener('scroll', onScroll)
  }, [])

  // A new screen opens at the top; going back returns to where you were —
  // retried for a moment while the page's content loads in.
  useLayoutEffect(() => {
    activeKey.current = location.key
    const target = navType === 'POP' ? (positions.current.get(location.key) ?? 0) : 0
    let tries = 0
    let frame = 0
    const settle = () => {
      window.scrollTo(0, target)
      if (Math.abs(window.scrollY - target) > 2 && tries++ < 90) frame = requestAnimationFrame(settle)
    }
    settle()
    // And make iOS repaint: a 1px round trip once the new page has rendered.
    const nudge = requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        const y = window.scrollY
        window.scrollTo(0, y + 1)
        window.scrollTo(0, y)
      }),
    )
    return () => {
      cancelAnimationFrame(frame)
      cancelAnimationFrame(nudge)
    }
  }, [location.key, navType])

  // Opened straight onto a deeper screen (a reload, an old link): rebuild its
  // ancestors underneath it, so the first swipe back lands on the parent.
  useEffect(() => {
    if (historyDepth() !== 0) return
    const chain = chainOf(here)
    if (chain.length < 2) return
    navigate(chain[0], { replace: true })
    chain.slice(1).forEach((p) => navigate(p))
    // Once, at startup.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Finish a goTo that had to step back first.
  useEffect(() => {
    if (!pending) return
    const job = pending
    pending = null
    if (here === job.at) job.push.forEach((p) => navigate(p))
  }, [here, navigate])

  return null
}

type LinkProps = Omit<AnchorHTMLAttributes<HTMLAnchorElement>, 'href'> & { to: string }

/** Use instead of React Router's <Link>: navigates with goTo, so history stays
 * shaped like the screen chain. */
export function Link({ to, onClick, ...rest }: LinkProps) {
  const href = useHref(to)
  const { goTo } = useAppNav()
  return (
    <a
      href={href}
      {...rest}
      onClick={(e) => {
        onClick?.(e)
        if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return
        e.preventDefault()
        goTo(to)
      }}
    />
  )
}
