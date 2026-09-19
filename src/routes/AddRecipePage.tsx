import { useState, type ChangeEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import AppHeader from '../components/AppHeader'
import { useAuth } from '../auth/AuthProvider'
import { importRecipeViaAI, type AiImportResult } from '../data/aiImport'
import { createRecipeInHousehold } from '../data/recipes'
import { aiImportConfigured } from '../lib/aiConfig'
import { formatIngredient, formatMinutes } from '../lib/quantity'

/** Render a step's prose with {{ }} amount tokens unwrapped for the preview. */
function plainStep(text: string): string {
  return text.replace(/\{\{([^{}]*)\}\}/g, '$1')
}

function ReadPreview({
  result,
  onSave,
  onRestart,
  saving,
  error,
}: {
  result: AiImportResult
  onSave: () => void
  onRestart: () => void
  saving: boolean
  error: string | null
}) {
  const r = result.seed
  const times = [
    ['Active', r.times.activeMin],
    ['Prep', r.times.prepMin],
    ['Cook', r.times.cookMin],
    ['Total', r.times.totalMin],
  ] as const

  return (
    <div className="space-y-5">
      <div>
        <h1 className="font-serif text-2xl leading-tight tracking-tight">{r.title}</h1>
        {r.subtitle && <p className="mt-1 text-ink-soft">{r.subtitle}</p>}
        {times.some(([, v]) => v !== null) && (
          <dl className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-sm">
            {times.map(([label, v]) =>
              v === null ? null : (
                <div key={label} className="flex gap-1.5">
                  <dt className="text-ink-faint">{label}</dt>
                  <dd className="font-medium">{formatMinutes(v)}</dd>
                </div>
              ),
            )}
          </dl>
        )}
      </div>

      {result.warnings.length > 0 && (
        <div className="rounded-xl border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-900/60 dark:bg-amber-950/40 dark:text-amber-200">
          <p className="font-medium">Worth a glance before saving:</p>
          <ul className="mt-1 list-inside list-disc space-y-0.5">
            {result.warnings.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
        </div>
      )}

      <section>
        <h2 className="mb-1 font-serif text-lg tracking-tight">Ingredients</h2>
        <ul className="space-y-1">
          {r.ingredients.map((ing) => {
            const f = formatIngredient(ing, 1)
            return (
              <li key={ing.id}>
                <span className="font-medium tabular-nums">
                  {[f.quantity, f.unit].filter(Boolean).join(' ')}
                </span>{' '}
                {f.item}
                {f.prep && <span className="text-ink-soft">, {f.prep}</span>}
              </li>
            )
          })}
        </ul>
      </section>

      <section>
        <h2 className="mb-1 font-serif text-lg tracking-tight">Method</h2>
        <ol className="space-y-2">
          {r.steps.map((step, i) => (
            <li key={step.id} className="flex gap-3">
              <span className="shrink-0 font-semibold text-ink-faint tabular-nums">{i + 1}</span>
              <span className="leading-relaxed">{plainStep(step.text)}</span>
            </li>
          ))}
        </ol>
      </section>

      {error && (
        <p role="alert" className="text-sm text-red-600 dark:text-red-400">
          {error}
        </p>
      )}

      <div className="flex gap-3">
        <button
          type="button"
          onClick={onSave}
          disabled={saving}
          className="grid h-14 flex-[1.4] place-items-center rounded-2xl bg-accent text-base font-semibold text-white transition active:scale-[0.99] disabled:opacity-50 dark:text-stone-900"
        >
          {saving ? 'Saving…' : 'Save recipe'}
        </button>
        <button
          type="button"
          onClick={onRestart}
          disabled={saving}
          className="grid h-14 flex-1 place-items-center rounded-2xl border border-line text-base font-semibold text-ink-soft transition active:scale-[0.99] disabled:opacity-50"
        >
          Start over
        </button>
      </div>
      <p className="text-center text-xs text-ink-faint">
        AI-read, then checked against the recipe rules. Give it a once-over — if
        something’s off, tweak the text and read it again.
      </p>
    </div>
  )
}

export default function AddRecipePage() {
  const { user, household } = useAuth()
  const navigate = useNavigate()

  const [tab, setTab] = useState<'text' | 'photo'>('text')
  const [text, setText] = useState('')
  const [image, setImage] = useState<{ data: string; mediaType: string; name: string } | null>(null)
  const [reading, setReading] = useState(false)
  const [result, setResult] = useState<AiImportResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  if (!user || !household) return null

  const isMember = household.memberUids.includes(user.uid)

  const onPickImage = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    const reader = new FileReader()
    reader.onload = () => {
      const url = String(reader.result)
      const comma = url.indexOf(',')
      setImage({ data: url.slice(comma + 1), mediaType: file.type || 'image/jpeg', name: file.name })
    }
    reader.readAsDataURL(file)
  }

  const read = async () => {
    setError(null)
    setReading(true)
    try {
      const input =
        tab === 'photo' && image
          ? { image: { data: image.data, mediaType: image.mediaType } }
          : { text }
      const res = await importRecipeViaAI(input)
      setResult(res)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Couldn’t read that recipe.')
    } finally {
      setReading(false)
    }
  }

  const save = async () => {
    if (!result) return
    setSaving(true)
    setError(null)
    try {
      const slug = await createRecipeInHousehold(result.seed, household.id, user.uid)
      navigate(`/r/${slug}`)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Couldn’t save the recipe.')
    } finally {
      setSaving(false)
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
        ) : !aiImportConfigured ? (
          <div className="mt-8 space-y-2 rounded-2xl border border-line bg-card p-4 text-sm text-ink-soft">
            <p className="font-medium text-ink">Recipe import isn’t set up yet</p>
            <p>
              Adding recipes by paste or photo needs a small one-time setup (a free
              Cloudflare Worker that holds the AI key). The steps are in{' '}
              <code className="text-accent">worker/README.md</code> — or ask me to
              walk you through it.
            </p>
          </div>
        ) : result ? (
          <ReadPreview
            result={result}
            onSave={save}
            onRestart={() => {
              setResult(null)
              setError(null)
            }}
            saving={saving}
            error={error}
          />
        ) : (
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
              <div className="space-y-3">
                <label className="grid min-h-40 cursor-pointer place-items-center rounded-2xl border border-dashed border-line bg-card p-6 text-center text-sm text-ink-soft">
                  <input
                    type="file"
                    accept="image/*"
                    capture="environment"
                    onChange={onPickImage}
                    className="hidden"
                  />
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
              </div>
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
            <p className="text-center text-xs text-ink-faint">
              Claude turns it into the app’s format; you review it before it saves.
            </p>
          </div>
        )}
      </main>
    </div>
  )
}
