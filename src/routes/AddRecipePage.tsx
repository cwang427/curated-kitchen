import { useState, type ChangeEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import AppHeader from '../components/AppHeader'
import RecipeEditor from '../components/RecipeEditor'
import { useAuth } from '../auth/AuthProvider'
import { importRecipeViaAI } from '../data/aiImport'
import { importRecipeFromUrl } from '../data/urlImport'
import { importRecipeFromText } from '../lib/importText'
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
  const [image, setImage] = useState<{ data: string; mediaType: string; name: string } | null>(null)
  const [reading, setReading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  if (!user || !household) return null
  const isMember = household.memberUids.includes(user.uid)

  const onPickImage = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    const reader = new FileReader()
    reader.onload = () => {
      const url = String(reader.result)
      setImage({ data: url.slice(url.indexOf(',') + 1), mediaType: file.type || 'image/jpeg', name: file.name })
    }
    reader.readAsDataURL(file)
  }

  // Photo / screenshot → AI (Gemini vision). No on-device fallback for images.
  const readPhoto = async () => {
    if (!image) return
    setError(null)
    setReading(true)
    try {
      const res = await importRecipeViaAI({ image: { data: image.data, mediaType: image.mediaType } })
      setInitial(res.seed)
      setMode('edit')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Couldn’t read that photo.')
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
            <label className="grid min-h-40 cursor-pointer place-items-center rounded-2xl border border-dashed border-line bg-card p-6 text-center text-sm text-ink-soft">
              <input type="file" accept="image/*" capture="environment" onChange={onPickImage} className="hidden" />
              {image ? (
                <span>
                  <span className="font-medium text-ink">{image.name}</span>
                  <span className="mt-1 block text-xs">Tap to choose a different photo</span>
                </span>
              ) : (
                <span>
                  Tap to take a photo or choose one
                  <span className="mt-1 block text-xs">a cookbook page, a recipe card, a screenshot</span>
                </span>
              )}
            </label>
            <p className="text-sm text-ink-soft">
              Snap or choose a photo of a recipe and we’ll read it in for you to review before saving.
            </p>

            {error && (
              <p role="alert" className="text-sm text-red-600 dark:text-red-400">
                {error}
              </p>
            )}

            <button
              type="button"
              onClick={readPhoto}
              disabled={!image || reading}
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
