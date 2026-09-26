import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { useAuth } from '../auth/AuthProvider'
import { addToList } from '../data/grocery'
import { fetchHouseholds } from '../data/household'
import { additionFromIngredient } from '../lib/grocery'
import { formatIngredient } from '../lib/quantity'
import { describeFirestoreError } from '../lib/errors'
import type { Household, Recipe } from '../lib/types'

/**
 * Pick which of a recipe's ingredients to add to the shared grocery list, at
 * the serving scale the recipe is showing. Amounts merge into the list by
 * canonical name + unit (see planMerge), so adding the same thing from two
 * recipes combines rather than duplicating.
 */
export default function AddToListSheet({
  recipe,
  scale,
  onClose,
}: {
  recipe: Recipe
  scale: number
  onClose: () => void
}) {
  const { user, household, profile } = useAuth()
  const [selected, setSelected] = useState<Set<string>>(
    () => new Set(recipe.ingredients.map((i) => i.id)),
  )
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [addedCount, setAddedCount] = useState<number | null>(null)

  // A member adds to the active kitchen's list. A guest (not a member of the
  // kitchen they're viewing) has no list here — friends never see it — so their
  // items go to one of THEIR OWN kitchens instead. When they belong to more than
  // one, they pick.
  const isMemberHere = !!(user && household && household.memberUids.includes(user.uid))
  const [ownKitchens, setOwnKitchens] = useState<Household[]>([])
  const [targetId, setTargetId] = useState<string | null>(isMemberHere ? household?.id ?? null : null)

  useEffect(() => {
    if (isMemberHere || !user || !profile) return
    let live = true
    fetchHouseholds(profile.householdIds)
      .then((hs) => {
        if (!live) return
        const mine = hs.filter((k) => k.memberUids.includes(user.uid))
        setOwnKitchens(mine)
        setTargetId((prev) => prev ?? mine[0]?.id ?? null)
      })
      .catch(() => {})
    return () => {
      live = false
    }
  }, [isMemberHere, user, profile])

  const targetName = isMemberHere
    ? household?.name ?? ''
    : ownKitchens.find((k) => k.id === targetId)?.name ?? ''

  const toggle = (id: string) =>
    setSelected((current) => {
      const next = new Set(current)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })

  const allSelected = selected.size === recipe.ingredients.length
  const setAll = (on: boolean) =>
    setSelected(on ? new Set(recipe.ingredients.map((i) => i.id)) : new Set())

  const add = async () => {
    if (!user || !targetId || selected.size === 0 || busy) return
    setBusy(true)
    setError(null)
    try {
      const additions = recipe.ingredients
        .filter((i) => selected.has(i.id))
        .map((i) => additionFromIngredient(i, scale))
      await addToList(targetId, user.uid, additions)
      setAddedCount(selected.size)
    } catch (cause) {
      setError(describeFirestoreError(cause, 'add to the grocery list'))
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
          <h2 className="font-serif text-lg tracking-tight">Add to grocery list</h2>
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

        {addedCount !== null ? (
          <div className="space-y-4 px-4 py-10 text-center">
            <p className="font-serif text-xl">
              Added {addedCount} to {isMemberHere ? 'your list' : `${targetName}`}
            </p>
            {isMemberHere ? (
              <div className="flex justify-center gap-3">
                <Link
                  to="/list"
                  className="min-h-11 rounded-full bg-accent px-5 text-sm font-semibold leading-[44px] text-white dark:text-stone-900"
                >
                  View list
                </Link>
                <button
                  type="button"
                  onClick={onClose}
                  className="min-h-11 rounded-full border border-line px-5 text-sm text-ink-soft"
                >
                  Keep cooking
                </button>
              </div>
            ) : (
              <>
                <p className="mx-auto max-w-sm text-balance text-sm text-ink-soft">
                  It’s on {targetName}’s grocery list. Switch to that kitchen (Settings → Your
                  kitchens) to see it.
                </p>
                <button
                  type="button"
                  onClick={onClose}
                  className="min-h-11 rounded-full bg-accent px-5 text-sm font-semibold text-white dark:text-stone-900"
                >
                  Done
                </button>
              </>
            )}
          </div>
        ) : (
          <>
            {/* Guests choose which of their own kitchens the items land in. */}
            {!isMemberHere &&
              (ownKitchens.length === 0 ? (
                <p className="px-4 py-2 text-sm text-ink-soft">
                  You need a kitchen of your own to keep a grocery list. Make one in Settings → Your
                  kitchens.
                </p>
              ) : ownKitchens.length === 1 ? (
                <p className="px-4 py-2 text-sm text-ink-faint">
                  Adding to <span className="font-medium text-ink">{targetName}</span>’s list
                </p>
              ) : (
                <label className="block px-4 py-2 text-sm">
                  <span className="mb-1 block text-ink-faint">Add to which kitchen’s list</span>
                  <select
                    value={targetId ?? ''}
                    onChange={(e) => setTargetId(e.target.value)}
                    className="min-h-11 w-full rounded-xl border border-line bg-card px-3 text-base outline-none focus:border-accent"
                  >
                    {ownKitchens.map((k) => (
                      <option key={k.id} value={k.id}>
                        {k.name}
                      </option>
                    ))}
                  </select>
                </label>
              ))}

            <div className="flex items-center justify-between px-4 py-2 text-sm">
              <span className="text-ink-faint">
                {selected.size} of {recipe.ingredients.length} selected
                {scale !== 1 && ` · ${scale}× amounts`}
              </span>
              <button
                type="button"
                onClick={() => setAll(!allSelected)}
                className="text-accent underline underline-offset-2"
              >
                {allSelected ? 'Select none' : 'Select all'}
              </button>
            </div>

            <ul className="px-2">
              {recipe.ingredients.map((ingredient) => {
                const f = formatIngredient(ingredient, scale)
                return (
                  <li key={ingredient.id}>
                    <label className="flex min-h-12 cursor-pointer items-start gap-3 rounded-lg px-2 py-2">
                      <input
                        type="checkbox"
                        checked={selected.has(ingredient.id)}
                        onChange={() => toggle(ingredient.id)}
                        className="mt-1 size-5 shrink-0 accent-[var(--accent)]"
                      />
                      <span>
                        {(f.quantity || f.unit) && (
                          <span className="font-medium">
                            {[f.quantity, f.unit].filter(Boolean).join(' ')}{' '}
                          </span>
                        )}
                        {f.item}
                      </span>
                    </label>
                  </li>
                )
              })}
            </ul>

            {error && (
              <p role="alert" className="px-4 pt-2 text-sm text-red-600 dark:text-red-400">
                {error}
              </p>
            )}

            <div className="sticky bottom-0 border-t border-line bg-paper/95 px-4 py-3 backdrop-blur">
              <button
                type="button"
                onClick={add}
                disabled={selected.size === 0 || busy || !targetId}
                className="min-h-12 w-full rounded-2xl bg-accent text-base font-semibold text-white transition active:scale-[0.99] disabled:opacity-50 dark:text-stone-900"
              >
                {busy ? 'Adding…' : `Add ${selected.size} to list`}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
