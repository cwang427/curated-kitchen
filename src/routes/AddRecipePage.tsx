import { useEffect, useRef, useState, type ChangeEvent } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import AppHeader from '../components/AppHeader'
import { historyDepth } from '../components/nav'
import RecipeEditor from '../components/RecipeEditor'
import { useAuth } from '../auth/AuthProvider'
import { importRecipeViaAI, type AiImportResult, type ImportError } from '../data/aiImport'
import { importRecipeFromUrl } from '../data/urlImport'
import { importRecipeFromText } from '../lib/importText'
import { compressForImport, readFileBase64 } from '../data/photos'
import { aiImportConfigured, urlImportConfigured } from '../lib/aiConfig'
import { busyRetryMs, isArchiveBusy } from '../lib/archiveBusy'
import type { RecipeSeed } from '../lib/types'

type Mode = 'choose' | 'link' | 'text' | 'capture' | 'edit'
const SCREENS: Mode[] = ['link', 'text', 'capture', 'edit']

/** A link read that needs the cook's say before the editor opens (readLink):
 * the recipe came but its photos didn't; the recipe reader (the AI) was
 * overloaded; or nothing could be read while the Archive was busy.
 * `retryAt` = when trying again is worthwhile. */
type LinkChoice =
  | { kind: 'no-photos'; result: AiImportResult; retryAt: number; blocked: boolean }
  | { kind: 'ai-busy'; retryAt: number }
  | { kind: 'busy'; message: string; retryAt: number }

/** "www.seriouseats.com" → "seriouseats.com", for messages. */
function siteOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return 'That site'
  }
}

export default function AddRecipePage() {
  const { user, household } = useAuth()
  const navigate = useNavigate()

  // Each screen (chooser → import screen → preview editor) is its own history
  // entry (?m=…), so the iPhone back-swipe steps through them exactly like the
  // back arrow. It's one mounted page throughout, so the pasted text / photos
  // survive stepping back from the editor to retry.
  const [params, setParams] = useSearchParams()
  const m = params.get('m') as Mode | null
  const mode: Mode = m && SCREENS.includes(m) ? m : 'choose'
  const open = (next: Mode) => setParams(next === 'choose' ? {} : { m: next })
  // Which import screen the editor was opened from ('choose' = from scratch),
  // i.e. how many entries back the chooser is.
  const [returnTo, setReturnTo] = useState<Mode>('choose')
  // A saved recipe waiting to replace this whole flow in history (see onSaved).
  const savedSlug = useRef<string | null>(null)
  const [initial, setInitial] = useState<RecipeSeed | null>(null)
  const [text, setText] = useState('')
  const [link, setLink] = useState('')
  // Photos and PDFs to read as one recipe. `src` is a thumbnail for photos; a
  // PDF has none and shows its file name instead.
  const [photos, setPhotos] = useState<{ src: string | null; data: string; mediaType: string; name: string }[]>([])
  const [preparing, setPreparing] = useState(false)
  const [reading, setReading] = useState(false)
  const [readSeconds, setReadSeconds] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [choice, setChoice] = useState<LinkChoice | null>(null)
  // A line above the preview editor about what the import couldn't bring.
  const [notice, setNotice] = useState<string | null>(null)
  // The link read in progress (a counter, so a read the cook walked away from
  // is ignored when it finishes), and whether one is running.
  const linkRun = useRef(0)
  const linkActive = useRef(false)

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

  // Leaving the link screen (Back, or the swipe) abandons its import: a read
  // still in flight is ignored, and a pending choice is dropped.
  useEffect(() => {
    if (mode === 'link') return
    setChoice(null)
    if (!linkActive.current) return
    linkActive.current = false
    linkRun.current++
    setReading(false)
  }, [mode])

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

  const openEditor = (seed: RecipeSeed | null, from: Mode, note: string | null = null) => {
    setNotice(note)
    setInitial(seed)
    setReturnTo(from)
    open('edit')
  }
  // Back = one history step, same as the swipe (import screen → chooser; editor
  // → the screen it came from). Opened straight onto a screen, go to the chooser.
  const goBack = () => {
    setError(null)
    if (historyDepth() > 0) navigate(-1)
    else setParams({}, { replace: true })
  }
  // Leave the editor for the chooser: one step back from scratch, two from an
  // import screen.
  const stepsToChooser = () => (returnTo === 'choose' ? 1 : 2)
  const toChooser = () => {
    setError(null)
    if (historyDepth() >= stepsToChooser()) navigate(-stepsToChooser())
    else setParams({}, { replace: true })
  }
  const onSaved = (slug: string) => {
    // Unwind to the chooser, then (effect above) replace it with the recipe —
    // so the add flow leaves no entries behind for a swipe to land on.
    if (historyDepth() >= stepsToChooser()) {
      savedSlug.current = slug
      navigate(-stepsToChooser())
    } else {
      navigate(`/r/${slug}`, { replace: true })
    }
  }

  // Photo(s) / screenshot(s) / PDF(s) → AI (Gemini vision). No on-device fallback.
  const readPhoto = async () => {
    if (photos.length === 0) return
    if (photos.reduce((n, p) => n + p.data.length, 0) > MAX_TOTAL_CHARS) {
      setError('That’s too much to send at once — remove a file or two.')
      return
    }
    setError(null)
    setReading(true)
    try {
      const res = await importRecipeViaAI({ images: photos.map((p) => ({ data: p.data, mediaType: p.mediaType })) })
      openEditor(res.seed, 'capture')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Couldn’t read those photos.')
    } finally {
      setReading(false)
    }
  }

  // A link. With AI set up, the Worker has Gemini read the page (through Google,
  // else via a reader service or the Internet Archive — big sites like Serious
  // Eats block plain server fetches) and handles blog-style pages with no
  // structured data. The Worker's JSON-LD route is the fallback when Gemini is
  // busy (and the only engine without AI).
  // A link: the Worker gets the page itself (directly, via a reader service, or
  // the Internet Archive's copy — big sites like Serious Eats block plain
  // server fetches) and has the AI read it, photos included. When it can read
  // the recipe but not bring everything, the cook chooses — never a silently
  // lesser import: continue without photos, or try again later. When the AI
  // itself is overloaded, just Try again (it usually frees up within a
  // minute). Without AI, the Worker's recipe-data route is the only engine.
  const readLink = async () => {
    const run = ++linkRun.current
    linkActive.current = true
    setError(null)
    setChoice(null)
    setReading(true)
    const url = link.trim()
    const current = () => run === linkRun.current
    try {
      if (!aiImportConfigured) {
        const { seed } = await importRecipeFromUrl(url)
        if (current()) openEditor(seed, 'link')
        return
      }
      const result = await importRecipeViaAI({ url })
      if (!current()) return
      const report = result.link
      if (report?.photosUnavailable) {
        // Read without the page itself (Google's reader), so without photos.
        if (report.retryAfterMs) {
          setChoice({ kind: 'no-photos', result, retryAt: Date.now() + report.retryAfterMs, blocked: true })
        } else {
          openEditor(result.seed, 'link', `${siteOf(url)} wouldn’t let us fetch its photos, so the recipe came without them — add your own with the photo buttons below.`)
        }
        return
      }
      const photos = report?.photos
      if (photos && photos.wanted > 0 && photos.got === 0) {
        setChoice({ kind: 'no-photos', result, retryAt: Date.now(), blocked: false })
        return
      }
      openEditor(
        result.seed,
        'link',
        photos && photos.got < photos.wanted
          ? `${photos.got} of ${photos.wanted} photos came through — the rest took too long. Add your own with the photo buttons below.`
          : null,
      )
    } catch (cause) {
      if (!current()) return
      const err = cause as ImportError
      if (isArchiveBusy(err)) {
        setChoice({ kind: 'busy', message: err.message, retryAt: Date.now() + busyRetryMs(err) })
      } else if (err.code === 'ai_busy') {
        setChoice({ kind: 'ai-busy', retryAt: Date.now() + 5_000 })
      } else {
        setError(err instanceof Error ? err.message : 'Couldn’t read that link.')
      }
    } finally {
      if (current()) {
        linkActive.current = false
        setReading(false)
      }
    }
  }
  // The cook's answer to a choice.
  const continueWithoutPhotos = (result: AiImportResult) => {
    setChoice(null)
    openEditor(result.seed, 'link', 'Imported without photos — add your own with the photo buttons below.')
  }
  // Nothing more to get from the link: the pasted-text screen, in its place
  // (so Back still goes to the chooser).
  const pasteInstead = () => {
    setChoice(null)
    setError(null)
    setParams({ m: 'text' }, { replace: true })
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
        } catch (aiErr) {
          // AI is the primary engine here; the on-device parser only reads text
          // with clear "Ingredients"/"Directions" headings. If it can't read
          // this either, show the AI's problem (usually "busy — try again")
          // rather than the parser's "add headings" note — the AI should have
          // handled it, and telling the cook to add headings is misleading.
          try {
            seed = importRecipeFromText(text).seed
          } catch {
            throw aiErr
          }
        }
      } else {
        seed = importRecipeFromText(text).seed
      }
      openEditor(seed, 'text')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Couldn’t read that recipe.')
    } finally {
      setReading(false)
    }
  }

  return (
    <div className="min-h-dvh">
      <AppHeader title="Add a recipe" back onBack={mode === 'choose' ? undefined : goBack} />

      <main className="pad-safe-bottom mx-auto max-w-3xl px-4 py-4">
        {!isMember ? (
          <p className="mt-10 text-center text-ink-soft">
            Only members can add recipes to this kitchen.
          </p>
        ) : mode === 'edit' ? (
          <>
            {notice && (
              <p role="note" className="mb-4 rounded-2xl border border-line bg-card p-4 text-sm text-ink-soft">
                {notice}
              </p>
            )}
            <RecipeEditor
              initial={initial}
              onSaved={onSaved}
              onCancel={toChooser}
            />
          </>
        ) : mode === 'link' ? (
          <div className="space-y-4">
            <input
              type="url"
              inputMode="url"
              autoCapitalize="off"
              autoCorrect="off"
              value={link}
              onChange={(e) => {
                setLink(e.target.value)
                setChoice(null)
              }}
              placeholder="https://…"
              aria-label="Recipe link"
              className="min-h-14 w-full rounded-2xl border border-line bg-card px-4 text-base outline-none placeholder:text-ink-faint focus:border-accent"
            />
            {error && (
              <div className="space-y-2">
                <p role="alert" className="text-sm text-red-600 dark:text-red-400">
                  {error}
                </p>
                <button
                  type="button"
                  onClick={pasteInstead}
                  className="text-sm font-medium text-accent underline underline-offset-2"
                >
                  Paste the recipe text instead
                </button>
              </div>
            )}

            {reading && <ReadingIndicator seconds={readSeconds} />}

            {choice?.kind === 'no-photos' && (
              <ChoicePanel
                title={choice.blocked ? 'We could read the recipe, but not its photos' : 'The recipe came through, but its photos didn’t'}
                body={
                  choice.blocked
                    ? `${siteOf(link.trim())} blocks apps like this one, and its saved copy at the Internet Archive is busy right now — that copy is where the photos come from. It usually frees up within a few minutes.`
                    : 'The photo downloads took too long. Trying again often brings them.'
                }
                primary={{ label: 'Continue without photos', onClick: () => continueWithoutPhotos(choice.result) }}
                retryAt={choice.retryAt}
                onRetry={readLink}
              />
            )}
            {choice?.kind === 'ai-busy' && (
              <ChoicePanel
                title="Couldn’t finish reading this recipe"
                body="The recipe reader we use (Google’s AI) is overloaded right now. That usually passes within a minute — try again shortly."
                retryAt={choice.retryAt}
                onRetry={readLink}
              />
            )}
            {choice?.kind === 'busy' && (
              <ChoicePanel
                title="Couldn’t read this one just now"
                body={`${choice.message} It usually frees up within a few minutes.`}
                primary={{ label: 'Paste the recipe text instead', onClick: pasteInstead }}
                retryAt={choice.retryAt}
                onRetry={readLink}
              />
            )}

            {!choice && (
              <button
                type="button"
                onClick={readLink}
                disabled={!canReadLink || reading}
                className="grid h-14 w-full place-items-center rounded-2xl bg-accent text-base font-semibold text-white transition active:scale-[0.99] disabled:opacity-50 dark:text-stone-900"
              >
                {reading ? 'Reading…' : 'Read recipe'}
              </button>
            )}
            <button
              type="button"
              onClick={goBack}
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
              placeholder="Paste the recipe here"
              aria-label="Recipe text"
              className="min-h-64 w-full rounded-2xl border border-line bg-card p-4 text-base outline-none placeholder:text-ink-faint focus:border-accent"
            />
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
              onClick={goBack}
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

            {reading && <ReadingIndicator seconds={readSeconds} />}

            <button
              type="button"
              onClick={readPhoto}
              disabled={photos.length === 0 || reading || preparing}
              className="grid h-14 w-full place-items-center rounded-2xl bg-accent text-base font-semibold text-white transition active:scale-[0.99] disabled:opacity-50 dark:text-stone-900"
            >
              {reading
                ? 'Reading…'
                : photos.length > 1
                  ? `Read recipe (${photos.length} ${photos.every((p) => p.src) ? 'photos' : 'files'})`
                  : 'Read recipe'}
            </button>
            <button
              type="button"
              onClick={goBack}
              className="w-full text-center text-sm text-ink-faint underline underline-offset-2"
            >
              Back
            </button>
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
              onClick={() => openEditor(null, 'choose')}
              className="w-full rounded-2xl border border-line bg-card p-4 text-left transition active:scale-[0.99]"
            >
              <span className="block font-medium">Start from scratch</span>
              <span className="mt-0.5 block text-sm text-ink-soft">Type in the recipe yourself</span>
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

/** A decision for the cook after a link read: go ahead with what we have, or
 * try again — enabled once trying again is worthwhile (`retryAt`), with the
 * time left on the button until then. Nothing happens by itself. */
function ChoicePanel({
  title,
  body,
  primary,
  retryAt,
  onRetry,
}: {
  title: string
  body: string
  /** Go ahead another way. Without it, Try again is the only (main) button. */
  primary?: { label: string; onClick: () => void }
  retryAt: number
  onRetry: () => void
}) {
  const [now, setNow] = useState(() => Date.now())
  const waiting = retryAt > now
  useEffect(() => {
    if (!waiting) return
    const id = setInterval(() => setNow(Date.now()), 500)
    return () => clearInterval(id)
  }, [waiting])
  const left = Math.max(0, Math.ceil((retryAt - now) / 1000))
  const clock = left >= 60 ? `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}` : `${left}s`
  return (
    <div role="status" className="space-y-3 rounded-2xl border border-line bg-card p-4">
      <div>
        <p className="font-medium text-ink">{title}</p>
        <p className="mt-1 text-sm text-ink-soft">{body}</p>
      </div>
      {primary && (
        <button
          type="button"
          onClick={primary.onClick}
          className="grid h-12 w-full place-items-center rounded-xl bg-accent px-4 text-base font-semibold text-white transition active:scale-[0.99] dark:text-stone-900"
        >
          {primary.label}
        </button>
      )}
      <button
        type="button"
        onClick={onRetry}
        disabled={waiting}
        className={`grid h-12 w-full place-items-center rounded-xl px-4 text-base transition active:scale-[0.99] disabled:opacity-60 ${
          primary
            ? 'border border-line font-medium text-ink'
            : 'bg-accent font-semibold text-white dark:text-stone-900'
        }`}
      >
        {waiting ? `Try again in ${clock}` : 'Try again'}
      </button>
    </div>
  )
}
