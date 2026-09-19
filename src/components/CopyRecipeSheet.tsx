import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { useAuth } from '../auth/AuthProvider'
import { copyRecipeToHousehold, fetchHouseholdRecipes, recipeLineage } from '../data/recipes'
import { fetchHouseholds } from '../data/household'
import { describeFirestoreError } from '../lib/errors'
import type { Household, Recipe } from '../lib/types'

/**
 * Copy a recipe into another kitchen you belong to. Copying creates a separate
 * recipe (the rules allow it only where you're a member), so edits and deletes
 * in the destination never touch the original.
 */
export default function CopyRecipeSheet({
  recipe,
  onClose,
}: {
  recipe: Recipe
  onClose: () => void
}) {
  const { user, profile } = useAuth()
  const [kitchens, setKitchens] = useState<Household[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [copiedTo, setCopiedTo] = useState<string | null>(null)
  // Kitchens that already hold a copy of this recipe's lineage → the existing
  // copy's title, so we can flag them and confirm before making a duplicate.
  const [dupes, setDupes] = useState<Record<string, string>>({})

  const ids = useMemo(() => profile?.householdIds ?? [], [profile])
  const lineage = recipeLineage(recipe)
  useEffect(() => {
    let live = true
    fetchHouseholds(ids)
      .then((hs) => {
        if (live) setKitchens(hs)
      })
      .catch(() => {})
    return () => {
      live = false
    }
  }, [ids])

  // Look up which target kitchens already have this lineage.
  useEffect(() => {
    if (!user) return
    let live = true
    const targetKitchens = kitchens.filter(
      (k) => k.memberUids.includes(user.uid) && k.id !== recipe.householdId,
    )
    Promise.all(
      targetKitchens.map(async (k) => {
        const existing = await fetchHouseholdRecipes(k.id).catch(() => [] as Recipe[])
        const match = existing.find((r) => r.copiedFrom === lineage)
        return match ? ([k.id, match.title] as const) : null
      }),
    ).then((pairs) => {
      if (live) setDupes(Object.fromEntries(pairs.filter((p): p is readonly [string, string] => p !== null)))
    })
    return () => {
      live = false
    }
  }, [kitchens, user, recipe.householdId, lineage])

  if (!user) return null

  // You can copy into kitchens where you're a member — never a guest — and not
  // into the recipe's own kitchen.
  const targets = kitchens.filter(
    (k) => k.memberUids.includes(user.uid) && k.id !== recipe.householdId,
  )

  const copy = async (k: Household) => {
    if (busy) return
    // Already copied here? Confirm before making a second one.
    if (
      dupes[k.id] &&
      !confirm(
        `You already copied “${recipe.title}” into ${k.name} (as “${dupes[k.id]}”). Copy again anyway?`,
      )
    ) {
      return
    }
    setBusy(true)
    setError(null)
    try {
      await copyRecipeToHousehold(recipe, k.id, user.uid)
      setCopiedTo(k.name)
    } catch (cause) {
      setError(describeFirestoreError(cause, 'copy the recipe'))
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
            {copiedTo ? 'Copied' : 'Copy to another kitchen'}
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

        {copiedTo ? (
          <div className="space-y-4 px-4 py-10 text-center">
            <p className="font-serif text-xl">
              Copied to <span className="text-accent">{copiedTo}</span>
            </p>
            <p className="mx-auto max-w-sm text-balance text-sm text-ink-soft">
              It’s a separate copy — editing or deleting it there won’t touch this one.
            </p>
            <button
              type="button"
              onClick={onClose}
              className="min-h-11 rounded-full bg-accent px-5 text-sm font-semibold text-white dark:text-stone-900"
            >
              Done
            </button>
          </div>
        ) : targets.length === 0 ? (
          <div className="space-y-3 px-4 py-10 text-center">
            <p className="text-ink-soft">No other kitchens to copy into.</p>
            <Link
              to="/settings"
              onClick={onClose}
              className="inline-block text-sm text-accent underline underline-offset-2"
            >
              Create or join one in Settings
            </Link>
          </div>
        ) : (
          <div className="px-2 py-2">
            <p className="px-2 pb-1 text-sm text-ink-faint">
              Puts a separate copy of “{recipe.title}” into:
            </p>
            <ul className="divide-y divide-line">
              {targets.map((k) => (
                <li key={k.id}>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => copy(k)}
                    className="flex min-h-14 w-full items-center justify-between gap-3 px-2 text-left disabled:opacity-50"
                  >
                    <span className="min-w-0">
                      <span className="block truncate">{k.name}</span>
                      <span className="block text-xs text-ink-faint">
                        {k.memberUids.length + k.friendUids.length > 1 ? 'Shared' : 'Personal'}
                      </span>
                    </span>
                    {dupes[k.id] && (
                      <span className="shrink-0 rounded-full bg-accent-soft px-2 py-0.5 text-xs font-medium text-accent">
                        Already copied
                      </span>
                    )}
                    <svg viewBox="0 0 24 24" className="size-5 shrink-0 text-ink-faint" fill="none" aria-hidden="true">
                      <path d="M9 5l7 7-7 7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  </button>
                </li>
              ))}
            </ul>
            {error && (
              <p role="alert" className="px-4 pt-2 text-sm text-red-600 dark:text-red-400">
                {error}
              </p>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
