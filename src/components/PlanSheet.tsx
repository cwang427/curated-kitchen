import { useMemo, useState } from 'react'
import { useAuth } from '../auth/AuthProvider'
import { addPlanEntry } from '../data/plan'
import { planWindow } from '../lib/plan'
import { describeFirestoreError } from '../lib/errors'
import type { Recipe } from '../lib/types'

/**
 * Add a recipe to the shared meal plan. Two ways in:
 *  - from a recipe (pass `recipe` + the reader's current `scale`) → straight to
 *    picking a day;
 *  - from the plan page (pass `recipes`) → search and pick a recipe first.
 * Choosing a day is the commit — one tap plans it.
 */
export default function PlanSheet({
  recipe,
  recipes = [],
  scale: initialScale = 1,
  onClose,
}: {
  recipe?: Recipe
  recipes?: Recipe[]
  scale?: number
  onClose: () => void
}) {
  const { user, household } = useAuth()
  const [picked, setPicked] = useState<Recipe | null>(recipe ?? null)
  const [term, setTerm] = useState('')
  const [scale, setScale] = useState(initialScale)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [plannedLabel, setPlannedLabel] = useState<string | null>(null)

  const window = useMemo(() => planWindow(new Date()), [])
  const scaleChips = useMemo(
    () => [...new Set([1, 2, 3, initialScale])].filter((s) => s > 0).sort((a, b) => a - b),
    [initialScale],
  )
  const matches = useMemo(() => {
    const needle = term.trim().toLowerCase()
    const sorted = [...recipes].sort((a, b) => a.title.localeCompare(b.title))
    if (!needle) return sorted
    return sorted.filter((r) => r.title.toLowerCase().includes(needle))
  }, [recipes, term])

  const plan = async (date: string | null, label: string) => {
    if (!user || !household || !picked || busy) return
    setBusy(true)
    setError(null)
    try {
      await addPlanEntry(household.id, user.uid, {
        recipeSlug: picked.slug,
        recipeTitle: picked.title,
        date,
        scale,
      })
      setPlannedLabel(label)
    } catch (cause) {
      setError(describeFirestoreError(cause, 'add to the meal plan'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="fixed inset-0 z-30 flex flex-col justify-end bg-black/40" onClick={onClose}>
      <div
        className="pad-safe-bottom max-h-[85dvh] overflow-y-auto rounded-t-3xl bg-paper"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="sticky top-0 flex items-center justify-between border-b border-line bg-paper/95 px-4 py-3 backdrop-blur">
          <h2 className="font-serif text-lg tracking-tight">
            {plannedLabel ? 'Added to the plan' : picked ? 'When are you making it?' : 'Plan a meal'}
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="grid size-9 place-items-center rounded-full text-ink-soft transition active:bg-line"
          >
            <svg viewBox="0 0 24 24" className="size-5" fill="none" aria-hidden="true">
              <path d="M6 6l12 12M18 6L6 18" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            </svg>
          </button>
        </div>

        {plannedLabel ? (
          <div className="space-y-4 px-4 py-10 text-center">
            <p className="font-serif text-xl">
              {picked?.title} · <span className="text-accent">{plannedLabel}</span>
            </p>
            <div className="flex justify-center gap-3">
              {!recipe && (
                <button
                  type="button"
                  onClick={() => {
                    setPicked(null)
                    setPlannedLabel(null)
                    setTerm('')
                  }}
                  className="min-h-11 rounded-full border border-line px-5 text-sm text-ink-soft"
                >
                  Plan another
                </button>
              )}
              <button
                type="button"
                onClick={onClose}
                className="min-h-11 rounded-full bg-accent px-5 text-sm font-semibold text-white dark:text-stone-900"
              >
                Done
              </button>
            </div>
          </div>
        ) : !picked ? (
          <div className="px-4 py-3">
            <input
              type="search"
              value={term}
              onChange={(e) => setTerm(e.target.value)}
              placeholder="Search recipes…"
              aria-label="Search recipes"
              className="min-h-12 w-full rounded-xl border border-line bg-card px-4 text-base outline-none placeholder:text-ink-faint focus:border-accent"
            />
            {matches.length === 0 ? (
              <p className="py-10 text-center text-ink-soft">No recipes match that.</p>
            ) : (
              <ul className="mt-2 divide-y divide-line">
                {matches.map((r) => (
                  <li key={r.id}>
                    <button
                      type="button"
                      onClick={() => setPicked(r)}
                      className="flex min-h-14 w-full items-center justify-between gap-3 text-left"
                    >
                      <span className="min-w-0 truncate">{r.title}</span>
                      <svg viewBox="0 0 24 24" className="size-5 shrink-0 text-ink-faint" fill="none" aria-hidden="true">
                        <path d="M9 5l7 7-7 7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        ) : (
          <div className="px-4 py-3">
            <p className="text-sm text-ink-faint">{picked.title}</p>

            {scaleChips.length > 1 && (
              <div className="mt-3">
                <p className="mb-1.5 text-sm font-medium">Batch</p>
                <div className="flex flex-wrap gap-2">
                  {scaleChips.map((s) => {
                    const active = s === scale
                    return (
                      <button
                        key={s}
                        type="button"
                        onClick={() => setScale(s)}
                        aria-pressed={active}
                        className={`min-h-11 rounded-full border px-4 text-sm transition ${
                          active ? 'border-accent bg-accent text-white dark:text-stone-900' : 'border-line bg-card text-ink-soft'
                        }`}
                      >
                        {s}×
                      </button>
                    )
                  })}
                </div>
              </div>
            )}

            <p className="mb-1.5 mt-4 text-sm font-medium">Day</p>
            <div className="grid grid-cols-2 gap-2">
              {window.map((day) => (
                <button
                  key={day.date}
                  type="button"
                  disabled={busy}
                  onClick={() => plan(day.date, day.label)}
                  className="flex min-h-14 flex-col items-start justify-center rounded-xl border border-line bg-card px-4 transition active:scale-[0.98] disabled:opacity-50"
                >
                  <span className="font-medium">{day.label}</span>
                  <span className="text-xs text-ink-faint">{day.sub}</span>
                </button>
              ))}
              <button
                type="button"
                disabled={busy}
                onClick={() => plan(null, 'Anytime')}
                className="col-span-2 min-h-12 rounded-xl border border-dashed border-line text-sm text-ink-soft transition active:scale-[0.99] disabled:opacity-50"
              >
                Anytime — no set day
              </button>
            </div>

            {error && (
              <p role="alert" className="pt-3 text-sm text-red-600 dark:text-red-400">
                {error}
              </p>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
