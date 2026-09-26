import { useCallback, useMemo, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import AppHeader from '../components/AppHeader'
import AddToListSheet from '../components/AddToListSheet'
import PlanSheet from '../components/PlanSheet'
import CopyRecipeSheet from '../components/CopyRecipeSheet'
import IngredientList from '../components/IngredientList'
import ScaleControl from '../components/ScaleControl'
import StepList from '../components/StepList'
import { useAuth } from '../auth/AuthProvider'
import HeartIcon from '../components/HeartIcon'
import { deleteRecipe, setRecipeFavorite, useRecipe } from '../data/recipes'
import { getDish, removeDish } from '../data/cookBoard'
import { describeFirestoreError } from '../lib/errors'
import { formatMinutes } from '../lib/quantity'

function useToggleSet() {
  const [ids, setIds] = useState<Set<string>>(new Set())
  const toggle = useCallback((id: string) => {
    setIds((current) => {
      const next = new Set(current)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })
  }, [])
  return [ids, toggle] as const
}

export default function RecipePage() {
  const { slug } = useParams<{ slug: string }>()
  const navigate = useNavigate()
  const { user, household } = useAuth()
  const { recipe, loading, error } = useRecipe(slug)
  // This recipe's dish on the cook board, if a solo cook is in progress here.
  const dish = useMemo(() => (slug ? getDish(slug) : null), [slug])
  const [scale, setScale] = useState(1)
  const [checkedIngredients, toggleIngredient] = useToggleSet()
  const [doneSteps, toggleStep] = useToggleSet()
  const [showAddToList, setShowAddToList] = useState(false)
  const [showAddToPlan, setShowAddToPlan] = useState(false)
  const [showCopy, setShowCopy] = useState(false)

  if (loading) {
    return (
      <div className="min-h-dvh">
        <AppHeader back />
        <p className="mt-16 text-center text-ink-faint">Loading…</p>
      </div>
    )
  }

  if (error || !recipe) {
    return (
      <div className="min-h-dvh">
        <AppHeader back />
        <div className="mx-auto max-w-3xl space-y-3 px-4 py-16 text-center">
          <p className="font-serif text-xl">
            {error ? 'Could not open that recipe' : 'Recipe not found'}
          </p>
          {error && <p className="text-sm text-ink-soft">{error}</p>}
          <Link to="/" className="inline-block text-accent underline">
            Back to all recipes
          </Link>
        </div>
      </div>
    )
  }

  const times = [
    ['Active', recipe.times.activeMin],
    ['Prep', recipe.times.prepMin],
    ['Cook', recipe.times.cookMin],
    ['Total', recipe.times.totalMin],
  ] as const

  const attribution = [recipe.source.author, recipe.source.name, recipe.source.book]
    .filter(Boolean)
    .join(' · ')

  const isMember = !!(user && household && household.memberUids.includes(user.uid))

  const onDelete = async () => {
    // The repo→Firestore sync is retired, so a delete is permanent for every
    // recipe (nothing re-creates it on push anymore).
    if (!confirm(`Delete “${recipe.title}”? This can’t be undone.`)) return
    try {
      await deleteRecipe(recipe.slug)
      navigate('/')
    } catch (cause) {
      alert(describeFirestoreError(cause, 'delete the recipe'))
    }
  }

  return (
    <div className="min-h-dvh">
      <AppHeader title={recipe.title} back plan cart />

      <main className="pad-safe-bottom mx-auto max-w-3xl px-4 py-5">
        <header className="space-y-3">
          <div className="flex items-start gap-3">
            <div className="min-w-0 flex-1">
              <h1 className="font-serif text-3xl leading-tight tracking-tight">
                {recipe.title}
              </h1>
              {recipe.subtitle && (
                <p className="mt-1 text-ink-soft">{recipe.subtitle}</p>
              )}
            </div>
            {/* Favorite ("pin") — kitchen-wide. Members toggle; guests just see
                it when it's set. */}
            {isMember ? (
              <button
                type="button"
                aria-pressed={recipe.favorite}
                aria-label={recipe.favorite ? 'Remove from favorites' : 'Add to favorites'}
                onClick={() => void setRecipeFavorite(recipe.slug, !recipe.favorite)}
                className={`-m-1 grid size-11 shrink-0 place-items-center rounded-full transition active:scale-90 ${
                  recipe.favorite ? 'text-accent' : 'text-ink-faint'
                }`}
              >
                <HeartIcon filled={recipe.favorite} className="size-7" />
              </button>
            ) : recipe.favorite ? (
              <span aria-label="Favorite" className="grid size-11 shrink-0 place-items-center text-accent">
                <HeartIcon filled className="size-7" />
              </span>
            ) : null}
          </div>

          {attribution && (
            <p className="text-sm text-ink-faint">
              {recipe.source.url ? (
                <a
                  href={recipe.source.url}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="underline decoration-line underline-offset-2"
                >
                  {attribution}
                </a>
              ) : (
                attribution
              )}
              {recipe.source.note && <span className="block italic">{recipe.source.note}</span>}
            </p>
          )}

          {times.some(([, value]) => value !== null) && (
            <dl className="flex flex-wrap gap-x-5 gap-y-1 text-sm">
              {times.map(([label, value]) =>
                value === null ? null : (
                  <div key={label} className="flex gap-1.5">
                    <dt className="text-ink-faint">{label}</dt>
                    <dd className="font-medium">{formatMinutes(value)}</dd>
                  </div>
                ),
              )}
            </dl>
          )}
        </header>

        {recipe.description && (
          <p className="mt-5 text-pretty leading-relaxed text-ink-soft">
            {recipe.description}
          </p>
        )}

        <div className="sticky top-16 z-10 -mx-4 mt-6 border-y border-line bg-paper/95 px-4 py-3 backdrop-blur">
          <ScaleControl scale={scale} onChange={setScale} recipeYield={recipe.yield} />
        </div>

        <div className="mt-6 space-y-3">
          {recipe.steps.length > 0 &&
            (dish ? (
              <div className="space-y-2">
                <Link
                  to={`/r/${recipe.slug}/cook?x=${dish.scale}`}
                  className="grid h-14 w-full place-items-center rounded-2xl bg-accent text-base font-semibold text-white transition active:scale-[0.99] dark:text-stone-900"
                >
                  Resume cooking →
                </Link>
                <button
                  type="button"
                  onClick={() => {
                    removeDish(recipe.slug)
                    navigate(`/r/${recipe.slug}/cook?x=${scale}`)
                  }}
                  className="w-full text-center text-sm text-ink-faint underline underline-offset-2"
                >
                  Start over
                </button>
              </div>
            ) : (
              <Link
                to={`/r/${recipe.slug}/cook?x=${scale}`}
                className="grid h-14 w-full place-items-center rounded-2xl bg-accent text-base font-semibold text-white transition active:scale-[0.99] dark:text-stone-900"
              >
                Start cooking →
              </Link>
            ))}
          <div className="flex gap-3">
            {/* Add-to-list works for guests too — it goes to one of THEIR own
                kitchens (the sheet picks), never this shared list. */}
            <button
              type="button"
              onClick={() => setShowAddToList(true)}
              className="grid h-14 flex-1 place-items-center rounded-2xl border border-line text-base font-semibold text-ink-soft transition active:scale-[0.99]"
            >
              Add to list
            </button>
            {/* The meal plan is members-only. */}
            {isMember && (
              <button
                type="button"
                onClick={() => setShowAddToPlan(true)}
                className="grid h-14 flex-1 place-items-center rounded-2xl border border-line text-base font-semibold text-ink-soft transition active:scale-[0.99]"
              >
                Add to plan
              </button>
            )}
          </div>

          {/* Copying makes an independent copy in a kitchen you're a member of,
              so guests can save a recipe into their own kitchen too. */}
          <button
            type="button"
            onClick={() => setShowCopy(true)}
            className="grid h-14 w-full place-items-center rounded-2xl border border-line text-base font-semibold text-ink-soft transition active:scale-[0.99]"
          >
            Copy to another kitchen
          </button>
        </div>

        {showAddToList && (
          <AddToListSheet recipe={recipe} scale={scale} onClose={() => setShowAddToList(false)} />
        )}
        {showAddToPlan && (
          <PlanSheet recipe={recipe} scale={scale} onClose={() => setShowAddToPlan(false)} />
        )}

        <section className="mt-6" aria-labelledby="ingredients-heading">
          <h2 id="ingredients-heading" className="mb-2 font-serif text-xl tracking-tight">
            Ingredients
          </h2>
          <IngredientList
            ingredients={recipe.ingredients}
            groups={recipe.groups}
            scale={scale}
            checked={checkedIngredients}
            onToggle={toggleIngredient}
          />
        </section>

        {recipe.equipment.length > 0 && (
          <section className="mt-7" aria-labelledby="equipment-heading">
            <h2 id="equipment-heading" className="mb-2 font-serif text-xl tracking-tight">
              Equipment
            </h2>
            <ul className="list-inside list-disc space-y-1 text-ink-soft">
              {recipe.equipment.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          </section>
        )}

        <section className="mt-7" aria-labelledby="steps-heading">
          <h2 id="steps-heading" className="mb-3 font-serif text-xl tracking-tight">
            Method
          </h2>
          <StepList
            steps={recipe.steps}
            ingredients={recipe.ingredients}
            groups={recipe.groups}
            scale={scale}
            done={doneSteps}
            onToggle={toggleStep}
          />
        </section>

        {recipe.notes.length > 0 && (
          <section className="mt-7" aria-labelledby="notes-heading">
            <h2 id="notes-heading" className="mb-2 font-serif text-xl tracking-tight">
              Notes
            </h2>
            <ul className="space-y-2 text-ink-soft">
              {recipe.notes.map((note) => (
                <li key={note} className="border-l-2 border-line pl-3 leading-relaxed">
                  {note}
                </li>
              ))}
            </ul>
          </section>
        )}

        {isMember && (
          <section className="mt-8 border-t border-line pt-5">
            <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-ink-faint">
              Manage
            </h2>
            <div className="flex flex-wrap gap-3">
              <Link
                to={`/r/${recipe.slug}/edit`}
                state={{ fromRecipe: true }}
                className="min-h-11 grid place-items-center rounded-full border border-line px-4 text-sm text-ink-soft transition active:scale-[0.98]"
              >
                Edit recipe
              </Link>
              <button
                type="button"
                onClick={onDelete}
                className="min-h-11 rounded-full border border-red-300 px-4 text-sm text-red-600 transition active:scale-[0.98] dark:border-red-900 dark:text-red-400"
              >
                Delete recipe
              </button>
            </div>
          </section>
        )}

        {showCopy && <CopyRecipeSheet recipe={recipe} onClose={() => setShowCopy(false)} />}
      </main>
    </div>
  )
}
