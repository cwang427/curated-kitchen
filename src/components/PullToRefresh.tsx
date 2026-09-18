import { useEffect, useRef, useState, type ReactNode } from 'react'

/**
 * Pull down at the top of the page to refresh, with a spinner for feedback.
 *
 * The recipe list is realtime, so a refresh is rarely *needed* — but pulling
 * down and getting nothing back reads as broken, and re-subscribing genuinely
 * helps when an iOS PWA resumes from the background with a stale listener.
 *
 * Body has `overscroll-behavior-y: none`, so there's no native bounce to fight;
 * this owns the gesture while the page is scrolled to the top.
 */

const RESISTANCE = 0.5 // pull feels heavier than the finger travels
const MAX_PULL = 90
const TRIGGER = 60

export default function PullToRefresh({
  onRefresh,
  children,
}: {
  onRefresh: () => Promise<void>
  children: ReactNode
}) {
  const [pull, setPull] = useState(0)
  const [refreshing, setRefreshing] = useState(false)

  // Logic reads/writes refs so the listeners can bind once; state is only for
  // rendering the indicator.
  const startY = useRef<number | null>(null)
  const pullRef = useRef(0)
  const refreshingRef = useRef(false)
  const onRefreshRef = useRef(onRefresh)
  onRefreshRef.current = onRefresh

  useEffect(() => {
    const onStart = (event: TouchEvent) => {
      startY.current = window.scrollY <= 0 && !refreshingRef.current ? event.touches[0].clientY : null
    }

    const onMove = (event: TouchEvent) => {
      if (startY.current === null) return
      const delta = event.touches[0].clientY - startY.current
      if (delta <= 0 || window.scrollY > 0) {
        startY.current = null
        if (pullRef.current !== 0) {
          pullRef.current = 0
          setPull(0)
        }
        return
      }
      // Taking over the gesture; stop the page from scrolling underneath.
      event.preventDefault()
      const next = Math.min(delta * RESISTANCE, MAX_PULL)
      pullRef.current = next
      setPull(next)
    }

    const onEnd = () => {
      if (startY.current === null) return
      startY.current = null
      if (pullRef.current >= TRIGGER && !refreshingRef.current) {
        refreshingRef.current = true
        setRefreshing(true)
        pullRef.current = 40
        setPull(40)
        void onRefreshRef
          .current()
          .catch(() => {})
          .finally(() => {
            refreshingRef.current = false
            setRefreshing(false)
            pullRef.current = 0
            setPull(0)
          })
      } else {
        pullRef.current = 0
        setPull(0)
      }
    }

    document.addEventListener('touchstart', onStart, { passive: true })
    document.addEventListener('touchmove', onMove, { passive: false })
    document.addEventListener('touchend', onEnd)
    document.addEventListener('touchcancel', onEnd)
    return () => {
      document.removeEventListener('touchstart', onStart)
      document.removeEventListener('touchmove', onMove)
      document.removeEventListener('touchend', onEnd)
      document.removeEventListener('touchcancel', onEnd)
    }
  }, [])

  const active = pull > 0 || refreshing
  const spin = refreshing || pull >= TRIGGER

  return (
    <div style={{ transform: active ? `translateY(${pull}px)` : undefined, transition: startY.current === null ? 'transform 0.2s' : undefined }}>
      <div
        aria-hidden={!active}
        className="pointer-events-none absolute inset-x-0 top-0 flex justify-center"
        style={{ transform: `translateY(${active ? -44 : -60}px)`, opacity: active ? 1 : 0 }}
      >
        <div className="grid size-9 place-items-center rounded-full border border-line bg-card shadow-sm">
          <svg
            viewBox="0 0 24 24"
            className={`size-5 text-accent ${spin ? 'animate-spin' : ''}`}
            style={{ transform: spin ? undefined : `rotate(${pull * 3}deg)` }}
            fill="none"
            aria-hidden="true"
          >
            <path
              d="M12 3a9 9 0 1 0 9 9"
              stroke="currentColor"
              strokeWidth="2.5"
              strokeLinecap="round"
            />
          </svg>
        </div>
      </div>
      {children}
    </div>
  )
}
