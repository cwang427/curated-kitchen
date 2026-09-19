import { useState, type ChangeEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import AppHeader from '../components/AppHeader'
import RecipeEditor from '../components/RecipeEditor'
import { useAuth } from '../auth/AuthProvider'
import { importRecipeViaAI } from '../data/aiImport'
import { aiImportConfigured } from '../lib/aiConfig'
import type { RecipeSeed } from '../lib/types'

type Mode = 'choose' | 'capture' | 'edit'

export default function AddRecipePage() {
  const { user, household } = useAuth()
  const navigate = useNavigate()

  const [mode, setMode] = useState<Mode>('choose')
  const [initial, setInitial] = useState<RecipeSeed | null>(null)
  const [tab, setTab] = useState<'text' | 'photo'>('text')
  const [text, setText] = useState('')
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

  const read = async () => {
    setError(null)
    setReading(true)
    try {
      const input =
        tab === 'photo' && image ? { image: { data: image.data, mediaType: image.mediaType } } : { text }
      const res = await importRecipeViaAI(input)
      setInitial(res.seed)
      setMode('edit')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Couldn’t read that recipe.')
    } finally {
      setReading(false)
    }
  }

  const canRead = tab === 'photo' ? !!image : text.trim().length > 0

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
        ) : mode === 'capture' ? (
          <div className="space-y-4">
            <div className="flex gap-2">
              {(['text', 'photo'] as const).map((t) => (
                <button
                  key={t}
                  type="button"
                  onClick={() => setTab(t)}
                  aria-pressed={tab === t}
                  className={`min-h-11 flex-1 rounded-xl border text-sm font-medium transition ${
                    tab === t ? 'border-accent bg-accent text-white dark:text-stone-900' : 'border-line bg-card text-ink-soft'
                  }`}
                >
                  {t === 'text' ? 'Paste text' : 'Photo'}
                </button>
              ))}
            </div>

            {tab === 'text' ? (
              <textarea
                value={text}
                onChange={(e) => setText(e.target.value)}
                placeholder="Paste a recipe from anywhere — Apple Notes, a website, a message…"
                aria-label="Recipe text"
                className="min-h-64 w-full rounded-2xl border border-line bg-card p-4 text-base outline-none placeholder:text-ink-faint focus:border-accent"
              />
            ) : (
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
                    <span className="mt-1 block text-xs">a cookbook page, a card, a screenshot</span>
                  </span>
                )}
              </label>
            )}

            {error && (
              <p role="alert" className="text-sm text-red-600 dark:text-red-400">
                {error}
              </p>
            )}

            <button
              type="button"
              onClick={read}
              disabled={!canRead || reading}
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
              onClick={() => { setInitial(null); setMode('edit') }}
              className="w-full rounded-2xl border border-line bg-card p-4 text-left transition active:scale-[0.99]"
            >
              <span className="block font-medium">Start from scratch</span>
              <span className="mt-0.5 block text-sm text-ink-soft">Type the recipe in yourself.</span>
            </button>

            {aiImportConfigured ? (
              <button
                type="button"
                onClick={() => setMode('capture')}
                className="w-full rounded-2xl border border-line bg-card p-4 text-left transition active:scale-[0.99]"
              >
                <span className="block font-medium">Paste text or a photo</span>
                <span className="mt-0.5 block text-sm text-ink-soft">
                  Read it in automatically, then review and edit before saving.
                </span>
              </button>
            ) : (
              <div className="rounded-2xl border border-line bg-card p-4 text-sm text-ink-soft">
                <span className="block font-medium text-ink">Paste or photo — coming soon</span>
                <span className="mt-0.5 block">
                  Automatic reading (paste text or snap a photo) arrives with the ingestion
                  engine. For now, start from scratch above.
                </span>
              </div>
            )}
          </div>
        )}
      </main>
    </div>
  )
}
