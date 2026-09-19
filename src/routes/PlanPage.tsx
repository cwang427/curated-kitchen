import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import AppHeader from '../components/AppHeader'
import PlanSheet from '../components/PlanSheet'
import { useAuth } from '../auth/AuthProvider'
import { useRecipes } from '../data/recipes'
import { addToList } from '../data/grocery'
import { clearPlan, removePlanEntry, setPlanEntryDate, usePlan } from '../data/plan'
import { groupPlan, planToAdditions, plannedWithRecipes, planWindow } from '../lib/plan'
import { describeFirestoreError } from '../lib/errors'
import type { PlanEntry, Recipe } from '../lib/types'

function EntryRow({
  entry,
  recipe,
  householdId,
  window,
}: {
  entry: PlanEntry
  recipe: Recipe | undefined
  householdId: string
  window: ReturnType<typeof planWindow>
}) {
  return (
    <li className="flex items-center gap-2">
      {recipe ? (
        <Link to={`/r/${recipe.slug}`} className="min-w-0 flex-1 py-2">
          <span className="block truncate">{entry.recipeTitle}</span>
        </Link>
      ) : (
        // The recipe was deleted or isn't loaded — keep the entry visible.
        <span className="min-w-0 flex-1 py-2 text-ink-faint line-through">{entry.recipeTitle}</span>
      )}

      {entry.scale !== 1 && (
        <span className="shrink-0 rounded-full bg-accent-soft px-2 py-0.5 text-xs font-semibold tabular-nums text-accent">
          {entry.scale}×
        </span>
      )}

      {/* Move to another day. Its value is this entry's day, so it reads as a
          per-meal control, not a list-wide filter. */}
      <select
        value={window.some((d) => d.date === entry.date) ? (entry.date ?? '') : ''}
        onChange={(e) => setPlanEntryDate(householdId, entry.id, e.target.value || null)}
        aria-label={`Move ${entry.recipeTitle}`}
        className="shrink-0 rounded-lg border border-line bg-card px-2 py-1 text-xs text-ink-soft outline-none focus:border-accent"
      >
        <option value="">Anytime</option>
        {window.map((d) => (
          <option key={d.date} value={d.date}>
            {d.label}
          </option>
        ))}
      </select>

      <button
        type="button"
        onClick={() => removePlanEntry(householdId, entry.id)}
        aria-label={`Remove ${entry.recipeTitle}`}
        className="grid size-9 shrink-0 place-items-center rounded-full text-ink-faint transition active:bg-line"
      >
        <svg viewBox="0 0 24 24" className="size-4" fill="none" aria-hidden="true">
          <path d="M6 6l12 12M18 6L6 18" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
        </svg>
      </button>
    </li>
  )
}

export default function PlanPage() {
  const { user, household } = useAuth()
  const householdId = household?.id ?? null
  const { recipes } = useRecipes(householdId)
  const { entries, loading, error } = usePlan(householdId)

  const [showAdd, setShowAdd] = useState(false)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)

  const window = useMemo(() => planWindow(new Date()), [])
  const recipeBySlug = useMemo(() => new Map(recipes.map((r) => [r.slug, r])), [recipes])
  const grouped = useMemo(() => groupPlan(entries, window), [entries, window])
  const cookable = plannedWithRecipes(entries, recipeBySlug)

  if (!user || !household || !householdId) return null

  const sendToList = async () => {
    if (busy) return
    setBusy(true)
    setNotice(null)
    setActionError(null)
    try {
      const additions = planToAdditions(entries, recipeBySlug)
      const { created, updated } = await addToList(householdId, user.uid, additions)
      setNotice(
        created + updated === 0
          ? 'Nothing to add yet — plan a meal first.'
          : `Added ${created} new item${created === 1 ? '' : 's'}${updated ? `, merged ${updated}` : ''} to your list.`,
      )
    } catch (cause) {
      setActionError(describeFirestoreError(cause, 'add the plan to the grocery list'))
    } finally {
      setBusy(false)
    }
  }

  const clearAll = async () => {
    if (busy || entries.length === 0) return
    if (!confirm('Clear the whole meal plan?')) return
    setBusy(true)
    try {
      await clearPlan(householdId, entries.map((e) => e.id))
      setNotice('Plan cleared.')
    } finally {
      setBusy(false)
    }
  }

  const hasEntries = entries.length > 0

  return (
    <div className="min-h-dvh">
      <AppHeader title="Meal plan" back cart />

      <main className="pad-safe-bottom mx-auto max-w-3xl px-4 py-4">
        <div className="flex gap-3">
          <button
            type="button"
            onClick={() => setShowAdd(true)}
            className="grid h-14 flex-1 place-items-center rounded-2xl bg-accent text-base font-semibold text-white transition active:scale-[0.99] dark:text-stone-900"
          >
            Plan a meal
          </button>
          <button
            type="button"
            onClick={sendToList}
            disabled={busy || cookable === 0}
            className="grid h-14 flex-1 place-items-center rounded-2xl border border-line text-base font-semibold text-ink-soft transition active:scale-[0.99] disabled:opacity-50"
          >
            {busy ? 'Adding…' : 'Add to grocery list'}
          </button>
        </div>

        {notice && (
          <div className="mt-3 flex items-center justify-between gap-3 rounded-xl bg-accent-soft px-4 py-2 text-sm text-accent">
            <span>{notice}</span>
            <Link to="/list" className="shrink-0 font-semibold underline underline-offset-2">
              View list
            </Link>
          </div>
        )}
        {(error || actionError) && (
          <p role="alert" className="mt-3 text-sm text-red-600 dark:text-red-400">
            {actionError ?? error}
          </p>
        )}

        {loading && <p className="mt-10 text-center text-ink-faint">Loading…</p>}

        {!loading && !hasEntries && (
          <div className="mt-16 space-y-2 text-center">
            <p className="font-serif text-xl">Nothing planned yet</p>
            <p className="mx-auto max-w-sm text-balance text-sm text-ink-soft">
              Tap <strong>Plan a meal</strong>, or open a recipe and choose a day. Then send the
              whole week to your grocery list in one tap.
            </p>
          </div>
        )}

        {hasEntries && (
          <div className="mt-5 space-y-5">
            {grouped.days
              .filter((d) => d.entries.length > 0)
              .map(({ day, entries: dayEntries }) => (
                <section key={day.date}>
                  <h2 className="mb-1 flex items-baseline gap-2">
                    <span className="text-sm font-semibold uppercase tracking-wide text-ink-faint">
                      {day.label}
                    </span>
                    <span className="text-xs text-ink-faint">{day.sub}</span>
                  </h2>
                  <ul className="divide-y divide-line">
                    {dayEntries.map((entry) => (
                      <EntryRow
                        key={entry.id}
                        entry={entry}
                        recipe={recipeBySlug.get(entry.recipeSlug)}
                        householdId={householdId}
                        window={window}
                      />
                    ))}
                  </ul>
                </section>
              ))}

            {grouped.anytime.length > 0 && (
              <section>
                <h2 className="mb-1 text-sm font-semibold uppercase tracking-wide text-ink-faint">
                  Anytime
                </h2>
                <ul className="divide-y divide-line">
                  {grouped.anytime.map((entry) => (
                    <EntryRow
                      key={entry.id}
                      entry={entry}
                      recipe={recipeBySlug.get(entry.recipeSlug)}
                      householdId={householdId}
                      window={window}
                    />
                  ))}
                </ul>
              </section>
            )}

            <button
              type="button"
              onClick={clearAll}
              disabled={busy}
              className="text-sm text-ink-faint underline underline-offset-2 disabled:opacity-50"
            >
              Clear plan
            </button>
          </div>
        )}
      </main>

      {showAdd && <PlanSheet recipes={recipes} onClose={() => setShowAdd(false)} />}
    </div>
  )
}
