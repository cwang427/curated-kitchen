import { useCallback, useMemo, useState } from 'react'
import { Link } from '../components/nav'
import AppHeader from '../components/AppHeader'
import PullToRefresh from '../components/PullToRefresh'
import SearchInput from '../components/SearchInput'
import { useAuth } from '../auth/AuthProvider'
import { collectTags, setRecipeFavorite, useCoverUpgrade, useRecipeSearch, useRecipes } from '../data/recipes'
import { endCookSession, useCookSession } from '../data/cooksession'
import { removeDish, useCookBoard } from '../data/cookBoard'
import { effectiveTotalMinutes, formatMinutes } from '../lib/quantity'
import HeartIcon from '../components/HeartIcon'
import type { Recipe } from '../lib/types'
import { normalizeTags } from '../lib/tags'

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

/** A picture for a recipe without a cover photo, from what kind of dish it
 * is (the most specific tag wins), so the grid stays even. */
const TILE_ICONS: Record<string, string> = {
  soup: '🥣', stew: '🍲', salad: '🥗', pasta: '🍝', noodles: '🍜', rice: '🍚',
  curry: '🍛', 'stir-fry': '🥘', sandwich: '🥪', pizza: '🍕', tacos: '🌮',
  dumplings: '🥟', casserole: '🥘', bread: '🍞', cake: '🍰', cookies: '🍪',
  pie: '🥧', breakfast: '🍳', appetizers: '🫒', sides: '🥦', desserts: '🍮',
  snacks: '🥨', drinks: '🍹', sauces: '🫙',
}
function tileIcon(tags: string[]): string {
  for (const tag of tags) if (TILE_ICONS[tag]) return TILE_ICONS[tag]
  return '🍽️'
}

/**
 * One recipe in the kitchen's two-column grid: its photo, its name and how
 * long it takes — what you pick tonight's dinner by. Everything else (source,
 * servings, tags) is on the recipe page, and the chips above filter by tag.
 */
function RecipeTile({
  recipe,
  canFavorite,
  onToggleFavorite,
}: {
  recipe: Recipe
  /** Members can toggle; guests only see a filled heart when it's a favorite. */
  canFavorite: boolean
  onToggleFavorite: () => void
}) {
  // Total time, start to finish — what "how long will this take?" means at a
  // glance, and the same figure the time filter uses.
  const time = formatMinutes(effectiveTotalMinutes(recipe.times))

  return (
    <Link
      to={`/r/${recipe.slug}`}
      className="relative flex flex-col overflow-hidden rounded-2xl border border-line bg-card shadow-sm transition active:scale-[0.98]"
    >
      {/* The card image stored inline on the recipe, so the list never
          fetches a photo doc per tile and nothing pops in while scrolling. */}
      {recipe.cover ? (
        <img
          src={recipe.cover.thumb}
          alt=""
          decoding="async"
          className="aspect-[4/3] w-full border-b border-line bg-accent-soft object-cover"
        />
      ) : (
        <span aria-hidden className="grid aspect-[4/3] w-full place-items-center border-b border-line bg-accent-soft text-4xl">
          {tileIcon(normalizeTags(recipe.tags))}
        </span>
      )}
      <div className="flex-1 px-3 pb-3 pt-2">
        <h3 className="line-clamp-2 font-serif text-base leading-snug tracking-tight">{recipe.title}</h3>
        {time && <p className="mt-1 text-xs text-ink-faint">{time}</p>}
      </div>
      {/* The heart sits on the photo's corner, on its own disc so it reads
          against any picture. */}
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
          className={`absolute right-1.5 top-1.5 grid size-10 place-items-center rounded-full bg-card shadow-sm transition active:scale-90 ${
            recipe.favorite ? 'text-accent' : 'text-ink-faint'
          }`}
        >
          <HeartIcon filled={recipe.favorite} className="size-5" />
        </button>
      ) : recipe.favorite ? (
        <span aria-label="Favorite" className="absolute right-1.5 top-1.5 grid size-10 place-items-center rounded-full bg-card text-accent shadow-sm">
          <HeartIcon filled className="size-5" />
        </span>
      ) : null}
    </Link>
  )
}

/** A heading between the kitchen's sections, with how many are in it. */
function SectionHeading({ id, label, count }: { id: string; label: string; count: number }) {
  return (
    <h2 id={id} className="mb-2 mt-5 flex items-baseline gap-2 text-sm font-semibold uppercase tracking-wide text-ink-faint">
      {label}
      <span className="font-normal normal-case tracking-normal">{count}</span>
    </h2>
  )
}

export default function RecipeListPage() {
  const { household, user } = useAuth()
  const [nonce, setNonce] = useState(0)
  // A guest (friend, not member) may only read recipes shared 'friends', and
  // the grocery list and cook session are members-only — so scope their reads.
  const isMember = !!(user && household && household.memberUids.includes(user.uid))
  const { recipes, loading, error } = useRecipes(household?.id ?? null, nonce, !isMember)
  useCoverUpgrade(recipes, isMember)
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

  const favorites = results.filter((r) => r.favorite)
  const rest = results.filter((r) => !r.favorite)

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
    // overflow-clip, not -hidden: it still hides the pull-to-refresh spinner's
    // resting spot above the page, but -hidden makes this div a scroll box, and
    // the sticky header then stuck to it instead of the screen (it scrolled away).
    <div className="relative min-h-dvh overflow-clip">
      <AppHeader add cart />

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
        <SearchInput
          value={term}
          onChange={setTerm}
          placeholder="Search recipes, ingredients, sources…"
          label="Search recipes"
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

        {/* Favorites first under their own heading, so a long kitchen has a
            landmark; without any favorites it's just the one grid. */}
        {[
          { key: 'favorites', label: 'Favorites', list: favorites },
          { key: 'rest', label: favorites.length ? 'Everything else' : '', list: rest },
        ].map(({ key, label, list }) =>
          list.length === 0 ? null : (
            <section key={key} aria-labelledby={label ? `${key}-heading` : undefined} className={label ? '' : 'mt-4'}>
              {label && <SectionHeading id={`${key}-heading`} label={label} count={list.length} />}
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                {list.map((recipe) => (
                  <RecipeTile
                    key={recipe.id}
                    recipe={recipe}
                    canFavorite={isMember}
                    onToggleFavorite={() => void setRecipeFavorite(recipe.slug, !recipe.favorite)}
                  />
                ))}
              </div>
            </section>
          ),
        )}
      </main>
      </PullToRefresh>
    </div>
  )
}
