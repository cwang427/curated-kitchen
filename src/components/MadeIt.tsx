import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { useAuth } from '../auth/AuthProvider'
import { markMade, setMyRating, takeRatePrompt, unmarkMade, useKitchenCooked, useMyCooked } from '../data/cooked'
import { describeFirestoreError } from '../lib/errors'
import { RATING_MAX, describeOthers, formatScore, kitchenScore, othersWhoMade } from '../lib/ratings'
import type { Recipe } from '../lib/types'
import CheckIcon from './CheckIcon'

const SCORES = Array.from({ length: RATING_MAX }, (_, i) => i + 1)

/**
 * "How was it?" — your score, 1–10, as ten big buttons (two rows of five, so
 * each is a real target with wet hands). A tap saves at once; tapping the lit
 * one again clears it. Opened from the recipe page, and after cook mode's
 * Finish ✓ (which has already marked it made).
 */
export function RateSheet({ slug, title, onClose }: { slug: string; title: string; onClose: () => void }) {
  const { user } = useAuth()
  const entry = useMyCooked()[slug] ?? null
  const [error, setError] = useState<string | null>(null)
  if (!user) return null

  // Writes go to the phone's copy first (the listener shows them at once) and
  // reach Firestore when they can, so nothing waits on the network here.
  const save = (write: Promise<void>, what: string) => {
    setError(null)
    write.catch((cause) => setError(describeFirestoreError(cause, what)))
  }
  const pick = (score: number) =>
    save(setMyRating(user.uid, slug, entry?.rating === score ? null : score, entry), 'save your score')
  const remove = () => {
    if (entry?.rating != null && !confirm(`Remove your ${entry.rating}/${RATING_MAX} for this recipe too?`)) return
    unmarkMade(user.uid, slug).catch((cause) => alert(describeFirestoreError(cause, 'update this recipe')))
    onClose()
  }

  return createPortal(
    <div className="fixed inset-0 z-30 flex flex-col justify-end bg-black/40" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="rate-heading"
        className="pad-safe-bottom max-h-[85dvh] overflow-y-auto rounded-t-3xl bg-paper"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="sticky top-0 flex items-center justify-between border-b border-line bg-paper px-4 py-3">
          <h2 id="rate-heading" className="font-serif text-lg tracking-tight">How was it?</h2>
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

        <div className="mx-auto max-w-md space-y-4 px-4 py-4">
          <div>
            <p className="font-medium">{title}</p>
            {entry ? (
              <p className="mt-0.5 flex items-center gap-1 text-sm text-check">
                <CheckIcon className="size-4" /> You made this
              </p>
            ) : (
              <p className="mt-0.5 text-sm text-ink-soft">Pick a score — that marks it as made too.</p>
            )}
          </div>

          <div>
            <div role="group" aria-label={`Your score, 1 to ${RATING_MAX}`} className="grid grid-cols-5 gap-2">
              {SCORES.map((score) => {
                const lit = entry?.rating === score
                return (
                  <button
                    key={score}
                    type="button"
                    aria-pressed={lit}
                    aria-label={`${score} out of ${RATING_MAX}`}
                    onClick={() => pick(score)}
                    className={`h-14 rounded-xl text-lg font-semibold tabular-nums transition active:scale-95 ${
                      lit ? 'bg-accent text-white dark:text-stone-900' : 'border border-line bg-card text-ink'
                    }`}
                  >
                    {score}
                  </button>
                )
              })}
            </div>
            <div className="mt-1.5 flex justify-between text-xs text-ink-faint">
              <span>1 · not again</span>
              <span>{RATING_MAX} · loved it</span>
            </div>
          </div>

          {error && <p role="alert" className="text-sm text-red-600 dark:text-red-400">{error}</p>}

          {entry ? (
            <>
              <button
                type="button"
                onClick={onClose}
                className="grid h-14 w-full place-items-center rounded-2xl bg-accent text-base font-semibold text-white transition active:scale-[0.99] dark:text-stone-900"
              >
                Done
              </button>
              <button
                type="button"
                onClick={remove}
                className="min-h-11 w-full text-center text-sm text-ink-faint underline underline-offset-2"
              >
                I haven’t made it — remove the ✓
              </button>
            </>
          ) : (
            <>
              {/* Made it but would rather not score it. */}
              <button
                type="button"
                onClick={() => {
                  markMade(user.uid, slug).catch((cause) => alert(describeFirestoreError(cause, 'mark it as made')))
                  onClose()
                }}
                className="grid h-14 w-full place-items-center rounded-2xl border border-line text-base font-semibold text-ink-soft transition active:scale-[0.99]"
              >
                Mark as made, no score
              </button>
              <button
                type="button"
                onClick={onClose}
                className="min-h-11 w-full text-center text-sm text-ink-faint underline underline-offset-2"
              >
                Cancel
              </button>
            </>
          )}
        </div>
      </div>
    </div>,
    document.body,
  )
}

/**
 * Under a recipe's times: your ✓ and score ("You made it · 8/10", or
 * "Made it? Rate it") — said as yours, since in a shared kitchen a bare score
 * could be anyone's — then the kitchen's average and who else made it. Each
 * person has their own: a couple can disagree, and a guest can rate what they
 * cook from a kitchen they visit.
 */
export default function MadeIt({ recipe }: { recipe: Recipe }) {
  const { user, household } = useAuth()
  const entry = useMyCooked()[recipe.slug] ?? null
  const kitchen = useKitchenCooked()
  const [rating, setRating] = useState(false)
  // The kitchen's people are the active kitchen's; a recipe opened from
  // another kitchen (by link) shows just yours.
  const here = !!household && recipe.householdId === household.id
  const others = here ? othersWhoMade(recipe.slug, kitchen) : []
  const average = here ? kitchenScore(recipe.slug, entry, kitchen) : null

  // Cook mode's Finish ✓ lands here asking how it was. In an effect, not a
  // state initializer, so React's dev-mode double render can't swallow it.
  useEffect(() => {
    if (takeRatePrompt(recipe.slug)) setRating(true)
  }, [recipe.slug])

  if (!user) return null

  return (
    <div>
      <button
        type="button"
        onClick={() => setRating(true)}
        className={`inline-flex min-h-11 items-center gap-1.5 rounded-full border px-4 text-sm font-medium transition active:scale-[0.98] ${
          entry ? 'border-check/40 bg-check/10 text-check' : 'border-line bg-card text-ink-soft'
        }`}
      >
        <CheckIcon className="size-4" />
        {entry ? (
          <span>
            You made it{' · '}
            {entry.rating !== null ? (
              <span className="tabular-nums">{entry.rating}/{RATING_MAX}</span>
            ) : (
              'Rate it'
            )}
          </span>
        ) : (
          <span>Made it? Rate it</span>
        )}
      </button>
      {others.length > 0 && (
        <p className="mt-1.5 text-sm text-ink-faint">
          {average !== null && (
            <>
              <span className="font-medium text-ink-soft">Kitchen average {formatScore(average)}/{RATING_MAX}</span>
              {' · '}
            </>
          )}
          {describeOthers(others)}
        </p>
      )}
      {rating && <RateSheet slug={recipe.slug} title={recipe.title} onClose={() => setRating(false)} />}
    </div>
  )
}
