import { useCallback, useEffect, useRef, useState, type TouchEvent } from 'react'
import { createPortal } from 'react-dom'

interface Props {
  /** Renderable srcs (photos are data URLs from their Firestore docs). */
  photos: string[]
  start: number
  onClose: () => void
}

type Zoom = { scale: number; x: number; y: number }
const NO_ZOOM: Zoom = { scale: 1, x: 0, y: 0 }
const MAX_SCALE = 4

type Gesture =
  | { kind: 'pinch'; dist: number; scale: number }
  | { kind: 'drag'; x: number; y: number; zx: number; zy: number; moved: boolean; onImage: boolean }

function distance(e: TouchEvent): number {
  const [a, b] = [e.touches[0], e.touches[1]]
  return Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY)
}

/**
 * Full-screen photo viewer: swipe or ‹ › between a set's photos, pinch or
 * double-tap to zoom (drag to look around while zoomed), and ✕ / a tap outside
 * the photo / Escape to close. Photos are data URLs, which iOS won't open in a
 * new window (that was the old blank white screen), and the app disables page
 * zoom, so zooming happens here.
 */
export default function PhotoViewer({ photos, start, onClose }: Props) {
  const count = photos.length
  const [index, setIndex] = useState(Math.min(Math.max(start, 0), count - 1))
  const [zoom, setZoom] = useState<Zoom>(NO_ZOOM)
  const [gesturing, setGesturing] = useState(false)
  const gesture = useRef<Gesture | null>(null)
  const lastTap = useRef(0)

  const go = useCallback(
    (delta: number) => {
      setIndex((i) => Math.min(Math.max(i + delta, 0), count - 1))
      setZoom(NO_ZOOM)
    },
    [count],
  )

  useEffect(() => {
    const previous = document.body.style.overflow
    document.body.style.overflow = 'hidden' // no page scroll behind the viewer
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
      else if (e.key === 'ArrowRight') go(1)
      else if (e.key === 'ArrowLeft') go(-1)
    }
    window.addEventListener('keydown', onKey)
    return () => {
      document.body.style.overflow = previous
      window.removeEventListener('keydown', onKey)
    }
  }, [go, onClose])

  const onTouchStart = (e: TouchEvent) => {
    setGesturing(true)
    if (e.touches.length === 2) {
      gesture.current = { kind: 'pinch', dist: distance(e), scale: zoom.scale }
      return
    }
    const t = e.touches[0]
    const onImage = (e.target as HTMLElement).tagName === 'IMG'
    gesture.current = { kind: 'drag', x: t.clientX, y: t.clientY, zx: zoom.x, zy: zoom.y, moved: false, onImage }
    // Double-tap on the photo toggles a 2.5× zoom.
    const now = Date.now()
    if (onImage && now - lastTap.current < 300) {
      setZoom((z) => (z.scale > 1 ? NO_ZOOM : { scale: 2.5, x: 0, y: 0 }))
      lastTap.current = 0
      gesture.current = null
    } else {
      lastTap.current = now
    }
  }

  const onTouchMove = (e: TouchEvent) => {
    const g = gesture.current
    if (!g) return
    if (g.kind === 'pinch' && e.touches.length === 2) {
      const scale = Math.min(Math.max((g.scale * distance(e)) / g.dist, 1), MAX_SCALE)
      setZoom((z) => (scale === 1 ? NO_ZOOM : { ...z, scale }))
    } else if (g.kind === 'drag' && e.touches.length === 1) {
      const t = e.touches[0]
      const dx = t.clientX - g.x
      const dy = t.clientY - g.y
      if (Math.abs(dx) > 8 || Math.abs(dy) > 8) g.moved = true
      // Zoomed in: the drag pans the photo. At 1× it's a swipe (on touch end).
      if (zoom.scale > 1) setZoom((z) => ({ ...z, x: g.zx + dx, y: g.zy + dy }))
    }
  }

  const onTouchEnd = (e: TouchEvent) => {
    const g = gesture.current
    if (e.touches.length > 0) return // a finger is still down
    setGesturing(false)
    gesture.current = null
    if (!g || g.kind !== 'drag' || zoom.scale > 1) return
    const t = e.changedTouches[0]
    const dx = t.clientX - g.x
    const dy = t.clientY - g.y
    if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy)) go(dx < 0 ? 1 : -1)
    else if (!g.moved && !g.onImage) onClose() // a tap on the dark backdrop
  }

  // Portaled to <body> so no surrounding layout (e.g. a parent's space-y
  // margins) can shape a full-screen overlay.
  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Photo"
      className="fixed inset-0 z-50 flex flex-col bg-black text-white"
    >
      <div className="pad-safe-top flex items-center justify-between px-4 pb-2">
        <span className="text-sm text-white/70">{count > 1 ? `${index + 1} / ${count}` : ''}</span>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close photo"
          className="grid size-11 place-items-center rounded-full bg-white/15 transition active:bg-white/30"
        >
          <svg viewBox="0 0 24 24" className="size-6" fill="none" aria-hidden="true">
            <path d="M6 6l12 12M18 6L6 18" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          </svg>
        </button>
      </div>

      <div
        className="relative flex min-h-0 flex-1 touch-none items-center justify-center overflow-hidden"
        onTouchStart={onTouchStart}
        onTouchMove={onTouchMove}
        onTouchEnd={onTouchEnd}
        onClick={(e) => {
          // Mouse / desktop: a click on the backdrop closes.
          if (e.target === e.currentTarget) onClose()
        }}
      >
        <img
          key={index}
          src={photos[index]}
          alt=""
          draggable={false}
          className="max-h-full max-w-full select-none object-contain"
          style={{
            transform: `translate(${zoom.x}px, ${zoom.y}px) scale(${zoom.scale})`,
            transition: gesturing ? 'none' : 'transform 150ms ease-out',
          }}
        />

        {count > 1 && (
          <>
            <button
              type="button"
              onClick={() => go(-1)}
              disabled={index === 0}
              aria-label="Previous photo"
              className="absolute left-3 top-1/2 grid size-12 -translate-y-1/2 place-items-center rounded-full bg-black/50 ring-1 ring-white/25 transition active:bg-black/70 disabled:opacity-0"
            >
              <svg viewBox="0 0 24 24" className="size-6" fill="none" aria-hidden="true">
                <path d="M15 19l-7-7 7-7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
            <button
              type="button"
              onClick={() => go(1)}
              disabled={index === count - 1}
              aria-label="Next photo"
              className="absolute right-3 top-1/2 grid size-12 -translate-y-1/2 place-items-center rounded-full bg-black/50 ring-1 ring-white/25 transition active:bg-black/70 disabled:opacity-0"
            >
              <svg viewBox="0 0 24 24" className="size-6" fill="none" aria-hidden="true">
                <path d="M9 5l7 7-7 7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
          </>
        )}
      </div>

      {count > 1 && (
        <div className="pad-safe-bottom flex justify-center gap-2 pt-3" aria-hidden="true">
          {photos.map((_, i) => (
            <span key={i} className={`size-2 rounded-full ${i === index ? 'bg-white' : 'bg-white/35'}`} />
          ))}
        </div>
      )}
    </div>,
    document.body,
  )
}

/**
 * A step's (or recipe's) photos, large enough to read at arm's length: one photo
 * full width, several in a swipeable row. Tapping one opens the full-screen
 * viewer on that photo, with the rest of the set a swipe away.
 */
export function PhotoStrip({ srcs, className = '' }: { srcs: string[]; className?: string }) {
  const [open, setOpen] = useState<number | null>(null)
  if (srcs.length === 0) return null
  return (
    <>
      {srcs.length === 1 ? (
        <button type="button" onClick={() => setOpen(0)} aria-label="View photo" className={`block w-full ${className}`}>
          <img src={srcs[0]} alt="" loading="lazy" className="max-h-80 w-full rounded-2xl border border-line object-cover" />
        </button>
      ) : (
        <div className={`flex snap-x gap-3 overflow-x-auto ${className}`}>
          {srcs.map((src, i) => (
            <button
              key={i}
              type="button"
              onClick={() => setOpen(i)}
              aria-label={`View photo ${i + 1} of ${srcs.length}`}
              className="shrink-0 snap-start"
            >
              <img
                src={src}
                alt=""
                loading="lazy"
                className="h-48 w-auto max-w-[80vw] rounded-2xl border border-line object-cover"
              />
            </button>
          ))}
        </div>
      )}
      {open !== null && <PhotoViewer photos={srcs} start={open} onClose={() => setOpen(null)} />}
    </>
  )
}
