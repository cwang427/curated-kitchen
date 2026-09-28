import { useState } from 'react'
import { createPortal } from 'react-dom'
import Cropper, { type Area, type MediaSize } from 'react-easy-crop'
import { cropToFile } from '../data/photos'

interface Props {
  /** The photo to crop (a data URL). */
  src: string
  /** Lock the frame to one shape — the cover is always 3:2, how it's shown. */
  lockAspect?: number
  onCancel: () => void
  /** The cropped photo, ready for the usual compression. */
  onDone: (file: File) => void
}

const SHAPES: { label: string; aspect: number | 'original' }[] = [
  { label: 'Original', aspect: 'original' },
  { label: 'Square', aspect: 1 },
  { label: '4:3', aspect: 4 / 3 },
  { label: '3:4', aspect: 3 / 4 },
  { label: '16:9', aspect: 16 / 9 },
]

/**
 * Crop a photo in the app: drag to position, pinch (or the slider) to zoom,
 * rotate in 90° turns, pick a shape. Tapping Done without changing anything
 * keeps the whole photo, so it never gets in the way.
 */
export default function PhotoCropper({ src, lockAspect, onCancel, onDone }: Props) {
  const [crop, setCrop] = useState({ x: 0, y: 0 })
  const [zoom, setZoom] = useState(1)
  const [rotation, setRotation] = useState(0)
  const [shape, setShape] = useState<number | 'original'>(lockAspect ?? 'original')
  const [media, setMedia] = useState<MediaSize | null>(null)
  const [area, setArea] = useState<Area | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // "Original" follows the photo — flipped when it's turned on its side.
  const natural = media ? media.naturalWidth / media.naturalHeight : 4 / 3
  const aspect = shape === 'original' ? (rotation % 180 === 0 ? natural : 1 / natural) : shape

  const done = async () => {
    if (!area) return
    setBusy(true)
    setError(null)
    try {
      onDone(await cropToFile(src, area, rotation))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Couldn’t crop that photo.')
      setBusy(false)
    }
  }

  // Portaled to <body> so no surrounding layout (e.g. a parent's space-y
  // margins, which cut 28px off the bottom) can shape a full-screen overlay.
  return createPortal(
    <div role="dialog" aria-modal="true" aria-label="Crop photo" className="fixed inset-0 z-50 flex flex-col bg-black text-white">
      <div className="pad-safe-top flex items-center justify-between gap-3 px-4 pb-3">
        <button type="button" onClick={onCancel} className="min-h-11 px-2 text-base text-white/80">
          Cancel
        </button>
        <span className="font-medium">Crop photo</span>
        <button
          type="button"
          onClick={done}
          disabled={!area || busy}
          className="min-h-11 rounded-full bg-accent px-5 text-base font-semibold text-white disabled:opacity-50 dark:text-stone-900"
        >
          {busy ? 'Saving…' : 'Done'}
        </button>
      </div>

      <div className="relative min-h-0 flex-1">
        <Cropper
          image={src}
          crop={crop}
          zoom={zoom}
          rotation={rotation}
          aspect={aspect}
          minZoom={1}
          maxZoom={4}
          onCropChange={setCrop}
          onZoomChange={setZoom}
          onCropComplete={(_, pixels) => setArea(pixels)}
          onMediaLoaded={setMedia}
          objectFit="contain"
        />
      </div>

      <div className="pad-safe-bottom space-y-3 px-4 pt-4">
        {error && <p role="alert" className="text-center text-sm text-red-300">{error}</p>}
        {!lockAspect && (
          <div className="flex gap-2 overflow-x-auto">
            {SHAPES.map((s) => (
              <button
                key={s.label}
                type="button"
                onClick={() => setShape(s.aspect)}
                aria-pressed={shape === s.aspect}
                className={`min-h-10 shrink-0 rounded-full px-4 text-sm font-medium ${
                  shape === s.aspect ? 'bg-white text-black' : 'bg-white/15 text-white'
                }`}
              >
                {s.label}
              </button>
            ))}
          </div>
        )}
        <div className="flex items-center gap-4">
          <button
            type="button"
            onClick={() => setRotation((r) => (r + 90) % 360)}
            aria-label="Rotate 90°"
            className="grid size-11 shrink-0 place-items-center rounded-full bg-white/15 active:bg-white/30"
          >
            <svg viewBox="0 0 24 24" className="size-6" fill="none" aria-hidden="true">
              <path d="M20 11a8 8 0 1 0-2.3 5.7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
              <path d="M20 4v7h-7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
          <input
            type="range"
            min={1}
            max={4}
            step={0.01}
            value={zoom}
            onChange={(e) => setZoom(Number(e.target.value))}
            aria-label="Zoom"
            className="min-w-0 flex-1 accent-[var(--accent)]"
          />
        </div>
      </div>
    </div>,
    document.body,
  )
}
