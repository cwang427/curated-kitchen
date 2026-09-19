import { useCallback, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import AppHeader from '../components/AppHeader'
import PullToRefresh from '../components/PullToRefresh'
import { useAuth } from '../auth/AuthProvider'
import { collectTags, useRecipeSearch, useRecipes } from '../data/recipes'
import { useCookSession } from '../data/cooksession'
import { effectiveTotalMinutes, formatMinutes } from '../lib/quantity'
import type { Recipe } from '../lib/types'

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** Max-total-time filter buckets. */
const TIME_BUCKETS: Array<{ label: string; max: number | null }> = [
  { label: 'Any time', max: null },
  { label: '≤20 min', max: 20 },
  { label: '≤30 min', max: 30 },
  { label: '≤45 min', max: 45 },
  { label: '≤1 hr', max: 60 },
]

function RecipeCard({ recipe }: { recipe: Recipe }) {
  const time = formatMinutes(recipe.times.activeMin ?? recipe.times.totalMin)
  const servings =
    recipe.yield.amountMax
      ? `${recipe.yield.amount}–${recipe.yield.amountMax} ${recipe.yield.unit}`
      : `${recipe.yield.amount} ${recipe.yield.unit}`

  return (
    <Link
      to={`/r/${recipe.slug}`}
      className="block rounded-2xl border border-line bg-card p-4 shadow-sm transition active:scale-[0.99]"
    >
      <h2 className="font-serif text-lg leading-snug tracking-tight">{recipe.title}</h2>
      {recipe.subtitle && (
        <p className="mt-0.5 line-clamp-2 text-sm text-ink-soft">{recipe.subtitle}</p>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-ink-faint">
        {time && <span>{time}</span>}
        <span>{servings}</span>
        {recipe.source.name && <span>{recipe.source.name}</span>}
      </div>

      {recipe.tags.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-1.5">
          {recipe.tags.slice(0, 4).map((tag) => (
            <span
              key={tag}
              className="rounded-full bg-accent-soft px-2 py-0.5 text-xs text-accent"
            >
              {tag}
            </span>
          ))}
        </div>
      )}
    </Link>
  )
}

export default function RecipeListPage() {
  const { household, user } = useAuth()
  const [nonce, setNonce] = useState(0)
  const { recipes, loading, error } = useRecipes(household?.id ?? null, nonce)
  const { session } = useCookSession(household?.id ?? null)
  const [term, setTerm] = useState('')
  const [activeTags, setActiveTags] = useState<string[]>([])
  const [maxTime, setMaxTime] = useState<number | null>(null)

  const tags = collectTags(recipes)
  const searched = useRecipeSearch(recipes, term, activeTags)
  // A time filter excludes recipes whose total time is unknown — we can't
  // claim they're under the limit.
  const results = useMemo(
    () =>
      maxTime === null
        ? searched
        : searched.filter((r) => {
            const total = effectiveTotalMinutes(r.times)
            return total !== null && total <= maxTime
          }),
    [searched, maxTime],
  )

  const toggleTag = (tag: string) =>
    setActiveTags((current) =>
      current.includes(tag) ? current.filter((t) => t !== tag) : [...current, tag],
    )

  // Re-subscribe, and hold the spinner briefly so the pull registers as a
  // deliberate action rather than a flash.
  const refresh = useCallback(async () => {
    setNonce((n) => n + 1)
    await sleep(700)
  }, [])

  return (
    <div className="relative min-h-dvh overflow-hidden">
      <AppHeader plan cart />

      <PullToRefresh onRefresh={refresh}>
      <main className="pad-safe-bottom mx-auto max-w-3xl px-4 py-4">
        {session && (
          // The person who started the session is resuming their own cook; the
          // other member is joining someone else's.
          (() => {
            const mine = session.startedBy === user?.uid
            return (
              <Link
                to={`/r/${session.recipeSlug}/cook?x=${session.scale}`}
                className="mb-3 flex items-center gap-3 rounded-2xl border border-accent bg-accent-soft px-4 py-3 text-accent transition active:scale-[0.99]"
              >
                <span className="text-xl" aria-hidden="true">🍳</span>
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-semibold">
                    Cooking now — tap to {mine ? 'resume' : 'join'}
                  </span>
                  <span className="block truncate text-sm">
                    {!mine && session.startedByName ? `${session.startedByName} · ` : ''}
                    {session.recipeTitle}
                  </span>
                </span>
                <svg viewBox="0 0 24 24" className="size-5 shrink-0" fill="none" aria-hidden="true">
                  <path d="M9 5l7 7-7 7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </Link>
            )
          })()
        )}
        <input
          type="search"
          value={term}
          onChange={(event) => setTerm(event.target.value)}
          placeholder="Search recipes, ingredients, sources…"
          aria-label="Search recipes"
          className="min-h-12 w-full rounded-xl border border-line bg-card px-4 text-base outline-none placeholder:text-ink-faint focus:border-accent"
        />

        <div className="-mx-4 mt-3 flex gap-2 overflow-x-auto px-4 pb-1">
          {TIME_BUCKETS.map((bucket) => {
            const active = maxTime === bucket.max
            return (
              <button
                key={bucket.label}
                type="button"
                onClick={() => setMaxTime(bucket.max)}
                aria-pressed={active}
                className={`shrink-0 rounded-full border px-3 py-1.5 text-sm transition ${
                  active
                    ? 'border-accent bg-accent text-white dark:text-stone-900'
                    : 'border-line bg-card text-ink-soft'
                }`}
              >
                {bucket.label}
              </button>
            )
          })}
        </div>

        {tags.length > 0 && (
          <div className="-mx-4 mt-3 flex gap-2 overflow-x-auto px-4 pb-1">
            {tags.map((tag) => {
              const active = activeTags.includes(tag)
              return (
                <button
                  key={tag}
                  type="button"
                  onClick={() => toggleTag(tag)}
                  aria-pressed={active}
                  className={`shrink-0 rounded-full border px-3 py-1.5 text-sm transition ${
                    active
                      ? 'border-accent bg-accent text-white dark:text-stone-900'
                      : 'border-line bg-card text-ink-soft'
                  }`}
                >
                  {tag}
                </button>
              )
            })}
          </div>
        )}

        {error && (
          <p role="alert" className="mt-6 text-sm text-red-600 dark:text-red-400">
            {error}
          </p>
        )}

        {loading && <p className="mt-8 text-center text-ink-faint">Loading recipes…</p>}

        {!loading && recipes.length === 0 && !error && (
          <div className="mt-16 space-y-2 text-center">
            <p className="font-serif text-xl">No recipes yet</p>
            <p className="mx-auto max-w-sm text-balance text-sm text-ink-soft">
              Add a recipe to <code className="text-accent">recipes/</code> and run{' '}
              <code className="text-accent">npm run sync:recipes</code> to see it here.
            </p>
          </div>
        )}

        {!loading && recipes.length > 0 && results.length === 0 && (
          <p className="mt-16 text-center text-ink-soft">Nothing matches that.</p>
        )}

        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          {results.map((recipe) => (
            <RecipeCard key={recipe.id} recipe={recipe} />
          ))}
        </div>
      </main>
      </PullToRefresh>
    </div>
  )
}
