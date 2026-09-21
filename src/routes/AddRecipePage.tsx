import { useEffect, useState, type ChangeEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import AppHeader from '../components/AppHeader'
import RecipeEditor from '../components/RecipeEditor'
import { useAuth } from '../auth/AuthProvider'
import { importRecipeViaAI } from '../data/aiImport'
import { importRecipeFromUrl } from '../data/urlImport'
import { importRecipeFromText } from '../lib/importText'
import { compressForImport } from '../data/photos'
import { aiImportConfigured, urlImportConfigured } from '../lib/aiConfig'
import type { RecipeSeed } from '../lib/types'

type Mode = 'choose' | 'link' | 'text' | 'capture' | 'edit'

export default function AddRecipePage() {
  const { user, household } = useAuth()
  const navigate = useNavigate()

  const [mode, setMode] = useState<Mode>('choose')
  const [initial, setInitial] = useState<RecipeSeed | null>(null)
  const [text, setText] = useState('')
  const [link, setLink] = useState('')
  const [photos, setPhotos] = useState<{ src: string; data: string; mediaType: string }[]>([])
  const [preparing, setPreparing] = useState(false)
  const [reading, setReading] = useState(false)
  const [readSeconds, setReadSeconds] = useState(0)
  const [error, setError] = useState<string | null>(null)

  // The AI read is a single call with no progress events, so we can't show a
  // real percentage — but a spinner plus an elapsed counter makes clear it's
  // working (a long paste can take several seconds).
  useEffect(() => {
    if (!reading) return
    setReadSeconds(0)
    const started = Date.now()
    const id = setInterval(() => setReadSeconds(Math.round((Date.now() - started) / 1000)), 500)
    return () => clearInterval(id)
  }, [reading])

  if (!user || !household) return null
  const isMember = household.memberUids.includes(user.uid)

  // A long recipe rarely fits one phone screenshot, so allow a few, read as one.
  const MAX_PHOTOS = 6

  const onPickImages = async (e: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? [])
    e.target.value = '' // let the same file be re-picked, and re-fire onChange
    if (files.length === 0) return
    setError(null)
    setPreparing(true)
    try {
      const room = MAX_PHOTOS - photos.length
      if (room <= 0) {
        setError(`You can add up to ${MAX_PHOTOS} photos.`)
        return
      }
      const added = await Promise.all(
        files.slice(0, room).map(async (file) => {
          // Downscale in-browser: keeps small text legible while keeping the
          // combined request light enough to send several at once.
          const src = await compressForImport(file)
          return { src, data: src.slice(src.indexOf(',') + 1), mediaType: 'image/jpeg' }
        }),
      )
      setPhotos((prev) => [...prev, ...added])
      if (files.length > room) setError(`Added the first ${room} — max is ${MAX_PHOTOS} photos.`)
    } catch {
      setError('Couldn’t read one of those photos. Try another.')
    } finally {
      setPreparing(false)
    }
  }

  const removePhoto = (i: number) => setPhotos((prev) => prev.filter((_, n) => n !== i))

  // Photo(s) / screenshot(s) → AI (Gemini vision). No on-device fallback for images.
  const readPhoto = async () => {
    if (photos.length === 0) return
    setError(null)
    setReading(true)
    try {
      const res = await importRecipeViaAI({ images: photos.map((p) => ({ data: p.data, mediaType: p.mediaType })) })
      setInitial(res.seed)
      setMode('edit')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Couldn’t read those photos.')
    } finally {
      setReading(false)
    }
  }

  const readLink = async () => {
    setError(null)
    setReading(true)
    try {
      const res = await importRecipeFromUrl(link.trim())
      setInitial(res.seed)
      setMode('edit')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Couldn’t read that link.')
    } finally {
      setReading(false)
    }
  }
  const canReadLink = /^https?:\/\/\S+/i.test(link.trim())

  // Text paste. When AI is set up it's the default engine (handles any layout);
  // the free on-device parser is the safety net for when it's offline or rate-
  // limited. Without AI configured, the on-device parser handles it alone.
  const readText = async () => {
    setError(null)
    setReading(true)
    try {
      let seed: RecipeSeed
      if (aiImportConfigured) {
        try {
          seed = (await importRecipeViaAI({ text })).seed
        } catch {
          seed = importRecipeFromText(text).seed
        }
      } else {
        seed = importRecipeFromText(text).seed
      }
      setInitial(seed)
      setMode('edit')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Couldn’t read that recipe.')
    } finally {
      setReading(false)
    }
  }

  return (
    <div className="min-h-dvh">
      <AppHeader title="Add a recipe" back />

      <main className="pad-safe-bottom mx-auto max-w-3xl px-4 py-4">
        {!isMember ? (
          <p className="mt-10 text-center text-ink-soft">
            Only members can add recipes to this kitchen.
          </p>
        ) : mode === 'edit' ? (
          <RecipeEditor
            initial={initial}
            onSaved={(slug) => navigate(`/r/${slug}`)}
            onCancel={() => setMode('choose')}
          />
        ) : mode === 'link' ? (
          <div className="space-y-4">
            <input
              type="url"
              inputMode="url"
              autoCapitalize="off"
              autoCorrect="off"
              value={link}
              onChange={(e) => setLink(e.target.value)}
              placeholder="https://…"
              aria-label="Recipe link"
              className="min-h-14 w-full rounded-2xl border border-line bg-card px-4 text-base outline-none placeholder:text-ink-faint focus:border-accent"
            />
            <p className="text-sm text-ink-soft">
              Paste a link from most cooking sites and we’ll pull the ingredients and steps for you
              to review before saving. Some sites block automatic reading — if it doesn’t work, use
              paste or a photo instead.
            </p>

            {error && (
              <p role="alert" className="text-sm text-red-600 dark:text-red-400">
                {error}
              </p>
            )}

            <button
              type="button"
              onClick={readLink}
              disabled={!canReadLink || reading}
              className="grid h-14 w-full place-items-center rounded-2xl bg-accent text-base font-semibold text-white transition active:scale-[0.99] disabled:opacity-50 dark:text-stone-900"
            >
              {reading ? 'Reading…' : 'Read recipe'}
            </button>
            <button
              type="button"
              onClick={() => { setMode('choose'); setError(null) }}
              className="w-full text-center text-sm text-ink-faint underline underline-offset-2"
            >
              Back
            </button>
          </div>
        ) : mode === 'text' ? (
          <div className="space-y-4">
            <textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder="Paste a recipe here — copy the whole page or just the recipe section. From a website, Apple Notes, a message, anywhere."
              aria-label="Recipe text"
              className="min-h-64 w-full rounded-2xl border border-line bg-card p-4 text-base outline-none placeholder:text-ink-faint focus:border-accent"
            />
            <p className="text-sm text-ink-soft">
              Works great for sites that block the link import: open the recipe, select all
              (⌘/Ctrl+A) and copy, then paste here. We’ll pull out the ingredients and steps for you
              to review — extra bits are easy to delete before saving.
            </p>

            {error && (
              <p role="alert" className="text-sm text-red-600 dark:text-red-400">
                {error}
              </p>
            )}

            {reading && <ReadingIndicator seconds={readSeconds} />}

            <button
              type="button"
              onClick={readText}
              disabled={text.trim().length === 0 || reading}
              className="grid h-14 w-full place-items-center rounded-2xl bg-accent text-base font-semibold text-white transition active:scale-[0.99] disabled:opacity-50 dark:text-stone-900"
            >
              {reading ? 'Reading…' : 'Read recipe'}
            </button>
            <button
              type="button"
              onClick={() => { setMode('choose'); setError(null) }}
              className="w-full text-center text-sm text-ink-faint underline underline-offset-2"
            >
              Back
            </button>
          </div>
        ) : mode === 'capture' ? (
          <div className="space-y-4">
            {photos.length > 0 && (
              <div className="grid grid-cols-3 gap-2">
                {photos.map((p, i) => (
                  <div key={i} className="relative">
                    <img src={p.src} alt={`Recipe photo ${i + 1}`} className="h-28 w-full rounded-xl border border-line object-cover" />
                    <button
                      type="button"
                      onClick={() => removePhoto(i)}
                      aria-label={`Remove photo ${i + 1}`}
                      className="absolute right-1 top-1 grid h-7 w-7 place-items-center rounded-full bg-black/60 text-base leading-none text-white"
                    >
                      ×
                    </button>
                  </div>
                ))}
              </div>
            )}

            {photos.length < MAX_PHOTOS && (
              <label className="grid min-h-32 cursor-pointer place-items-center rounded-2xl border border-dashed border-line bg-card p-6 text-center text-sm text-ink-soft">
                <input type="file" accept="image/*" multiple onChange={onPickImages} className="hidden" />
                {preparing ? (
                  <span>Adding…</span>
                ) : photos.length > 0 ? (
                  <span>
                    Add another photo
                    <span className="mt-1 block text-xs">{photos.length} of {MAX_PHOTOS} added</span>
                  </span>
                ) : (
                  <span>
                    Tap to take photos or choose screenshots
                    <span className="mt-1 block text-xs">add several of one recipe — we read them together</span>
                  </span>
                )}
              </label>
            )}
            <p className="text-sm text-ink-soft">
              A long recipe rarely fits one screenshot — add each part (in order) and we’ll combine
              them into one recipe for you to review before saving.
            </p>

            {error && (
              <p role="alert" className="text-sm text-red-600 dark:text-red-400">
                {error}
              </p>
            )}

            {reading && <ReadingIndicator seconds={readSeconds} />}

            <button
              type="button"
              onClick={readPhoto}
              disabled={photos.length === 0 || reading || preparing}
              className="grid h-14 w-full place-items-center rounded-2xl bg-accent text-base font-semibold text-white transition active:scale-[0.99] disabled:opacity-50 dark:text-stone-900"
            >
              {reading ? 'Reading…' : photos.length > 1 ? `Read recipe (${photos.length} photos)` : 'Read recipe'}
            </button>
            <button
              type="button"
              onClick={() => { setMode('choose'); setError(null) }}
              className="w-full text-center text-sm text-ink-faint underline underline-offset-2"
            >
              Back
            </button>
          </div>
        ) : (
          /* choose */
          <div className="space-y-4">
            <button
              type="button"
              onClick={() => setMode('text')}
              className="w-full rounded-2xl border border-line bg-card p-4 text-left transition active:scale-[0.99]"
            >
              <span className="block font-medium">Paste text</span>
              <span className="mt-0.5 block text-sm text-ink-soft">
                Copy a recipe from anywhere — a website, Apple Notes, a message — and we’ll read it
                in for you. Free, works offline.
              </span>
            </button>

            {aiImportConfigured && (
              <button
                type="button"
                onClick={() => setMode('capture')}
                className="w-full rounded-2xl border border-line bg-card p-4 text-left transition active:scale-[0.99]"
              >
                <span className="block font-medium">Scan a photo</span>
                <span className="mt-0.5 block text-sm text-ink-soft">
                  Snap a cookbook page, a recipe card, or a screenshot and we’ll read it in for you.
                </span>
              </button>
            )}

            {urlImportConfigured && (
              <button
                type="button"
                onClick={() => setMode('link')}
                className="w-full rounded-2xl border border-line bg-card p-4 text-left transition active:scale-[0.99]"
              >
                <span className="block font-medium">Paste a link</span>
                <span className="mt-0.5 block text-sm text-ink-soft">
                  Read a recipe straight from most cooking sites, then review before saving.
                </span>
              </button>
            )}

            {/* Manual entry is the last resort, below the import options. */}
            <button
              type="button"
              onClick={() => { setInitial(null); setMode('edit') }}
              className="w-full rounded-2xl border border-line bg-card p-4 text-left transition active:scale-[0.99]"
            >
              <span className="block font-medium">Start from scratch</span>
              <span className="mt-0.5 block text-sm text-ink-soft">Type the recipe in yourself.</span>
            </button>
          </div>
        )}
      </main>
    </div>
  )
}

/** Indeterminate progress for an AI read: a spinner plus an elapsed counter, so
 * a multi-second wait doesn't feel frozen. After a while it reassures rather
 * than worries. */
function ReadingIndicator({ seconds }: { seconds: number }) {
  return (
    <div role="status" aria-live="polite" className="flex items-center gap-3 rounded-2xl border border-line bg-card p-4">
      <span
        aria-hidden
        className="h-6 w-6 shrink-0 animate-spin rounded-full border-2 border-line border-t-accent"
      />
      <div className="text-sm">
        <p className="font-medium text-ink">Reading your recipe…{seconds >= 3 ? ` (${seconds}s)` : ''}</p>
        <p className="text-ink-soft">
          {seconds >= 12
            ? 'Still going — a long recipe can take a little while. Hang tight.'
            : 'This usually takes a few seconds.'}
        </p>
      </div>
    </div>
  )
}
