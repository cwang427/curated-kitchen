import { useCallback, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import AppHeader from '../components/AppHeader'
import PullToRefresh from '../components/PullToRefresh'
import { useAuth } from '../auth/AuthProvider'
import { collectTags, setRecipeFavorite, useRecipeSearch, useRecipes } from '../data/recipes'
import { endCookSession, useCookSession } from '../data/cooksession'
import { removeDish, useCookBoard } from '../data/cookBoard'
import { effectiveTotalMinutes, formatMinutes } from '../lib/quantity'
import HeartIcon from '../components/HeartIcon'
import type { Recipe } from '../lib/types'

/** The "cooking now" banner at the top of the list — shared session or solo. */
function CookBanner({
  to,
  label,
  detail,
  onDismiss,
}: {
  to: string
  label: string
  detail: string
  /** When set, a × ends this cook instead of opening it (shown in place of the chevron). */
  onDismiss?: () => void
}) {
  return (
    <Link
      to={to}
      className="mb-3 flex items-center gap-3 rounded-2xl border border-accent bg-accent-soft px-4 py-3 text-accent transition active:scale-[0.99]"
    >
      <span className="text-xl" aria-hidden="true">🍳</span>
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-semibold">{label}</span>
        <span className="block truncate text-sm">{detail}</span>
      </span>
      {onDismiss ? (
        <button
          type="button"
          aria-label="End this cook"
          onClick={(e) => {
            e.preventDefault()
            e.stopPropagation()
            onDismiss()
          }}
          className="grid size-9 shrink-0 place-items-center rounded-full text-accent transition active:bg-accent/10"
        >
          <svg viewBox="0 0 24 24" className="size-5" fill="none" aria-hidden="true">
            <path d="M6 6l12 12M18 6L6 18" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          </svg>
        </button>
      ) : (
        <svg viewBox="0 0 24 24" className="size-5 shrink-0" fill="none" aria-hidden="true">
          <path d="M9 5l7 7-7 7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      )}
    </Link>
  )
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** Max-total-time filter buckets. */
const TIME_BUCKETS: Array<{ label: string; max: number | null }> = [
  { label: 'Any time', max: null },
  { label: '≤20 min', max: 20 },
  { label: '≤30 min', max: 30 },
  { label: '≤45 min', max: 45 },
  { label: '≤1 hr', max: 60 },
]

function RecipeCard({
  recipe,
  canFavorite,
  onToggleFavorite,
}: {
  recipe: Recipe
  /** Members can toggle; guests only see a filled heart when it's a favorite. */
  canFavorite: boolean
  onToggleFavorite: () => void
}) {
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
      <div className="flex items-start gap-2">
        <h2 className="min-w-0 flex-1 font-serif text-lg leading-snug tracking-tight">
          {recipe.title}
        </h2>
        {canFavorite ? (
          <button
            type="button"
            aria-pressed={recipe.favorite}
            aria-label={recipe.favorite ? `Unfavorite ${recipe.title}` : `Favorite ${recipe.title}`}
            onClick={(e) => {
              e.preventDefault()
              e.stopPropagation()
              onToggleFavorite()
            }}
            className={`-m-1 grid size-9 shrink-0 place-items-center rounded-full transition active:scale-90 ${
              recipe.favorite ? 'text-accent' : 'text-ink-faint'
            }`}
          >
            <HeartIcon filled={recipe.favorite} />
          </button>
        ) : recipe.favorite ? (
          <span aria-label="Favorite" className="grid size-9 shrink-0 place-items-center text-accent">
            <HeartIcon filled />
          </span>
        ) : null}
      </div>
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
  // A guest (friend, not member) may only read recipes shared 'friends', and
  // the grocery/plan/cook-session data is members-only — so scope their reads.
  const isMember = !!(user && household && household.memberUids.includes(user.uid))
  const { recipes, loading, error } = useRecipes(household?.id ?? null, nonce, !isMember)
  const { session } = useCookSession(isMember ? household?.id ?? null : null)
  // Solo cooks in progress on this device (the cook board).
  const board = useCookBoard()
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
      <AppHeader add plan cart />

      <PullToRefresh onRefresh={refresh}>
      <main className="pad-safe-bottom mx-auto max-w-3xl px-4 py-4">
        {/* A live shared session takes priority; otherwise the solo cook board —
            several dishes open the timeline, one resumes that dish directly. */}
        {session ? (
          <CookBanner
            to={`/r/${session.recipeSlug}/cook?x=${session.scale}`}
            label={`Cooking now — tap to ${session.startedBy === user?.uid ? 'resume' : 'join'}`}
            detail={
              session.startedBy !== user?.uid && session.startedByName
                ? `${session.startedByName} · ${session.recipeTitle}`
                : session.recipeTitle
            }
            // Only the person who started a shared cook can end it from here.
            onDismiss={
              session.startedBy === user?.uid && household
                ? () => void endCookSession(household.id)
                : undefined
            }
          />
        ) : board.dishes.length > 1 ? (
          <CookBanner
            to="/cooking"
            label={`Cooking now — ${board.dishes.length} dishes`}
            detail={board.dishes.map((d) => d.title).join(', ')}
          />
        ) : board.dishes.length === 1 ? (
          <CookBanner
            to={`/r/${board.dishes[0].slug}/cook?x=${board.dishes[0].scale}`}
            label="Cooking now — tap to resume"
            detail={board.dishes[0].title}
            onDismiss={() => removeDish(board.dishes[0].slug)}
          />
        ) : null}
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
            <p className="font-serif text-xl">
              {isMember ? 'No recipes yet' : 'Nothing shared with guests yet'}
            </p>
            <p className="mx-auto max-w-sm text-balance text-sm text-ink-soft">
              {isMember
                ? 'Tap the ＋ in the top bar to add your first recipe.'
                : 'Ask a member of this kitchen to share a recipe with guests.'}
            </p>
          </div>
        )}

        {!loading && recipes.length > 0 && results.length === 0 && (
          <p className="mt-16 text-center text-ink-soft">Nothing matches that.</p>
        )}

        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          {results.map((recipe) => (
            <RecipeCard
              key={recipe.id}
              recipe={recipe}
              canFavorite={isMember}
              onToggleFavorite={() => void setRecipeFavorite(recipe.slug, !recipe.favorite)}
            />
          ))}
        </div>
      </main>
      </PullToRefresh>
    </div>
  )
}
