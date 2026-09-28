import { useEffect, useRef, useState, type ChangeEvent } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import AppHeader from '../components/AppHeader'
import { historyDepth } from '../components/nav'
import RecipeEditor from '../components/RecipeEditor'
import { useAuth } from '../auth/AuthProvider'
import { compressForImport, readFileBase64 } from '../data/photos'
import { aiImportConfigured, urlImportConfigured } from '../lib/aiConfig'
import { startImport } from '../data/importQueue'
import { AwaitingReview } from '../components/ImportQueue'

type Mode = 'choose' | 'link' | 'text' | 'capture' | 'edit'
const SCREENS: Mode[] = ['link', 'text', 'capture', 'edit']

/**
 * Add a recipe: the ways in, then "Recipes awaiting review" — every import
 * runs in the background and lands there for a look before it joins the
 * kitchen (components/ImportQueue.tsx). Import on any screen starts it and
 * comes straight back here, where it shows how it's getting on.
 */
export default function AddRecipePage() {
  const { user, household } = useAuth()
  const navigate = useNavigate()

  // Each screen (chooser → import screen, or → the editor for "start from
  // scratch") is its own history entry (?m=…), so the iPhone back-swipe steps
  // through them exactly like the back arrow.
  const [params, setParams] = useSearchParams()
  const m = params.get('m') as Mode | null
  const mode: Mode = m && SCREENS.includes(m) ? m : 'choose'
  const open = (next: Mode) => setParams(next === 'choose' ? {} : { m: next })
  // A saved recipe waiting to replace this whole flow in history (see onSaved).
  const savedSlug = useRef<string | null>(null)
  const [text, setText] = useState('')
  const [link, setLink] = useState('')
  // Photos and PDFs to read as one recipe. `src` is a thumbnail for photos; a
  // PDF has none and shows its file name instead.
  const [photos, setPhotos] = useState<{ src: string | null; data: string; mediaType: string; name: string }[]>([])
  const [preparing, setPreparing] = useState(false)
  const [starting, setStarting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Leaving a screen clears its error.
  useEffect(() => setError(null), [mode])

  // Back at the chooser after a save: swap this entry for the new recipe, so
  // history reads list → recipe and a swipe back from it lands on the list.
  useEffect(() => {
    if (mode !== 'choose' || !savedSlug.current) return
    const slug = savedSlug.current
    savedSlug.current = null
    navigate(`/r/${slug}`, { replace: true })
  }, [mode, navigate])

  if (!user || !household) return null
  // Mid-hand-off to a just-saved recipe: don't flash the chooser.
  if (savedSlug.current && mode === 'choose') return null
  const isMember = household.memberUids.includes(user.uid)

  // A long recipe rarely fits one phone screenshot, so allow several, read as one.
  // Our cap, not Gemini's (it takes far more): it bounds the upload on cell data
  // and keeps the read inside the Worker's 30s per-model wait.
  const MAX_PHOTOS = 12
  // A PDF isn't downscaled like a photo (the AI reads it as-is), so cap its size
  // — and the whole request — to stay well under the AI's per-request limit.
  const MAX_PDF_MB = 10
  const MAX_TOTAL_CHARS = 18_000_000 // base64, ≈13 MB of files
  const isPdf = (file: File) => file.type === 'application/pdf' || /\.pdf$/i.test(file.name)

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
      const tooBig = files.filter((f) => isPdf(f) && f.size > MAX_PDF_MB * 1024 * 1024)
      const usable = files.filter((f) => !tooBig.includes(f))
      const added = await Promise.all(
        usable.slice(0, room).map(async (file) => {
          if (isPdf(file)) {
            return { src: null, data: await readFileBase64(file), mediaType: 'application/pdf', name: file.name }
          }
          // Downscale in-browser: keeps small text legible while keeping the
          // combined request light enough to send several at once.
          const src = await compressForImport(file)
          return { src, data: src.slice(src.indexOf(',') + 1), mediaType: 'image/jpeg', name: file.name }
        }),
      )
      setPhotos((prev) => [...prev, ...added])
      if (tooBig.length > 0) {
        setError(`That PDF is over ${MAX_PDF_MB} MB — too big to read. Try screenshots of just the recipe pages.`)
      } else if (usable.length > room) {
        setError(`Added the first ${room} — max is ${MAX_PHOTOS}.`)
      }
    } catch {
      setError('Couldn’t read one of those files. Try another.')
    } finally {
      setPreparing(false)
    }
  }

  const removePhoto = (i: number) => setPhotos((prev) => prev.filter((_, n) => n !== i))

  // Back = one history step, same as the swipe (a screen → the chooser).
  // Opened straight onto a screen, go to the chooser.
  const goBack = () => {
    setError(null)
    if (historyDepth() > 0) navigate(-1)
    else setParams({}, { replace: true })
  }
  const onSaved = (slug: string) => {
    // Unwind to the chooser, then (effect above) replace it with the recipe —
    // so the add flow leaves no entries behind for a swipe to land on.
    if (historyDepth() > 0) {
      savedSlug.current = slug
      navigate(-1)
    } else {
      navigate(`/r/${slug}`, { replace: true })
    }
  }

  /** Start an import, then back to the list, where it shows its progress. */
  const begin = async (job: Parameters<typeof startImport>[0], clear: () => void) => {
    setError(null)
    setStarting(true)
    try {
      await startImport(job, household.id)
      clear()
      goBack()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Couldn’t start that import.')
    } finally {
      setStarting(false)
    }
  }

  // Photo(s) / screenshot(s) / PDF(s) → the AI (Gemini vision), run here in
  // the app (they're too big to park with the Worker).
  const readPhoto = () => {
    if (photos.length === 0) return
    if (photos.reduce((n, p) => n + p.data.length, 0) > MAX_TOTAL_CHARS) {
      setError('That’s too much to send at once — remove a file or two.')
      return
    }
    const pdfs = photos.filter((p) => !p.src)
    const name =
      pdfs.length === photos.length && photos.length === 1
        ? photos[0].name || 'Recipe PDF'
        : pdfs.length
          ? `${photos.length} files`
          : photos.length === 1
            ? 'A recipe photo'
            : `${photos.length} recipe photos`
    void begin({ images: photos.map((p) => ({ data: p.data, mediaType: p.mediaType })), name }, () => setPhotos([]))
  }

  // A link: the Worker's queue gets the page (directly, through a reader, or
  // the Internet Archive's copy) and has the AI read it — and keeps trying,
  // even with the app closed, if it can't right now.
  const canReadLink = /^https?:\/\/\S+/i.test(link.trim())
  const readLink = () => void begin({ url: link.trim() }, () => setLink(''))

  // Pasted text: the AI reads it (any layout); this phone's own reader is the
  // fallback when the AI can't be reached.
  const readText = () => void begin({ text }, () => setText(''))

  return (
    <div className="min-h-dvh">
      <AppHeader title="Add a recipe" back onBack={mode === 'choose' ? undefined : goBack} />

      <main className="pad-safe-bottom mx-auto max-w-3xl px-4 py-4">
        {!isMember ? (
          <p className="mt-10 text-center text-ink-soft">
            Only members can add recipes to this kitchen.
          </p>
        ) : mode === 'edit' ? (
          <RecipeEditor initial={null} onSaved={onSaved} onCancel={goBack} />
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
            {error && (
              <p role="alert" className="text-sm text-red-600 dark:text-red-400">
                {error}
              </p>
            )}
            <ImportButton onClick={readLink} disabled={!canReadLink} starting={starting} />
            <BackLink onClick={goBack} />
          </div>
        ) : mode === 'text' ? (
          <div className="space-y-4">
            <textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder="Paste the recipe here"
              aria-label="Recipe text"
              className="min-h-64 w-full rounded-2xl border border-line bg-card p-4 text-base outline-none placeholder:text-ink-faint focus:border-accent"
            />
            {error && (
              <p role="alert" className="text-sm text-red-600 dark:text-red-400">
                {error}
              </p>
            )}

            <ImportButton onClick={readText} disabled={text.trim().length === 0} starting={starting} />
            <BackLink onClick={goBack} />
          </div>
        ) : mode === 'capture' ? (
          <div className="space-y-4">
            {photos.length > 0 && (
              <div className="grid grid-cols-3 gap-2">
                {photos.map((p, i) => (
                  <div key={i} className="relative">
                    {p.src ? (
                      <img src={p.src} alt={`Recipe photo ${i + 1}`} className="h-28 w-full rounded-xl border border-line object-cover" />
                    ) : (
                      <div className="flex h-28 w-full flex-col items-center justify-center gap-1.5 rounded-xl border border-line bg-card px-2 text-center">
                        <svg viewBox="0 0 24 24" className="size-7 text-ink-faint" fill="none" aria-hidden="true">
                          <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
                          <path d="M14 3v5h5" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
                        </svg>
                        <span className="w-full truncate text-xs text-ink-soft">{p.name || 'PDF'}</span>
                      </div>
                    )}
                    <button
                      type="button"
                      onClick={() => removePhoto(i)}
                      aria-label={`Remove ${p.src ? 'photo' : 'PDF'} ${i + 1}`}
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
                <input type="file" accept="image/*,application/pdf,.pdf" multiple onChange={onPickImages} className="hidden" />
                {preparing ? (
                  <span>Adding…</span>
                ) : photos.length > 0 ? (
                  <span>
                    Add another photo or PDF
                    <span className="mt-1 block text-xs">{photos.length} of {MAX_PHOTOS} added</span>
                  </span>
                ) : (
                  <span>Tap to add photos or a PDF</span>
                )}
              </label>
            )}
            {error && (
              <p role="alert" className="text-sm text-red-600 dark:text-red-400">
                {error}
              </p>
            )}

            <ImportButton
              onClick={readPhoto}
              disabled={photos.length === 0 || preparing}
              starting={starting}
              label={photos.length > 1 ? `Import (${photos.length} ${photos.every((p) => p.src) ? 'photos' : 'files'})` : 'Import'}
            />
            <BackLink onClick={goBack} />
          </div>
        ) : (
          /* choose */
          <div className="space-y-4">
            {(aiImportConfigured || urlImportConfigured) && (
              <button
                type="button"
                onClick={() => open('link')}
                className="w-full rounded-2xl border border-line bg-card p-4 text-left transition active:scale-[0.99]"
              >
                <span className="block font-medium">Add from URL</span>
                <span className="mt-0.5 block text-sm text-ink-soft">
                  Paste a link to a recipe. Works for most recipe sites. (Paywalled sites won’t work.)
                </span>
              </button>
            )}

            <button
              type="button"
              onClick={() => open('text')}
              className="w-full rounded-2xl border border-line bg-card p-4 text-left transition active:scale-[0.99]"
            >
              <span className="block font-medium">Add from pasted text</span>
              <span className="mt-0.5 block text-sm text-ink-soft">
                Copy a recipe in text format from anywhere, and paste here
              </span>
            </button>

            {aiImportConfigured && (
              <button
                type="button"
                onClick={() => open('capture')}
                className="w-full rounded-2xl border border-line bg-card p-4 text-left transition active:scale-[0.99]"
              >
                <span className="block font-medium">Add from photo or PDF</span>
                <span className="mt-0.5 block text-sm text-ink-soft">
                  Upload screenshots/pictures of a recipe or a PDF
                </span>
              </button>
            )}

            {/* Manual entry is the last resort, below the import options. */}
            <button
              type="button"
              onClick={() => open('edit')}
              className="w-full rounded-2xl border border-line bg-card p-4 text-left transition active:scale-[0.99]"
            >
              <span className="block font-medium">Start from scratch</span>
              <span className="mt-0.5 block text-sm text-ink-soft">Type in the recipe yourself</span>
            </button>
            <AwaitingReview />
          </div>
        )}
      </main>
    </div>
  )
}

/** Start the import. It then runs in the background — the list on Add a
 * recipe shows how it's going — so this only waits for it to be under way. */
function ImportButton({ onClick, disabled, starting, label = 'Import' }: { onClick: () => void; disabled: boolean; starting: boolean; label?: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled || starting}
      className="grid h-14 w-full place-items-center rounded-2xl bg-accent text-base font-semibold text-white transition active:scale-[0.99] disabled:opacity-50 dark:text-stone-900"
    >
      {starting ? 'Starting…' : label}
    </button>
  )
}

function BackLink({ onClick }: { onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} className="w-full text-center text-sm text-ink-faint underline underline-offset-2">
      Back
    </button>
  )
}
