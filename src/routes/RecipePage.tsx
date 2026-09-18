import { useCallback, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import AppHeader from '../components/AppHeader'
import IngredientList from '../components/IngredientList'
import ScaleControl from '../components/ScaleControl'
import StepList from '../components/StepList'
import { useRecipe } from '../data/recipes'
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
  const { recipe, loading, error } = useRecipe(slug)
  const [scale, setScale] = useState(1)
  const [checkedIngredients, toggleIngredient] = useToggleSet()
  const [doneSteps, toggleStep] = useToggleSet()

  if (loading) {
    return (
      <div className="min-h-dvh">
        <AppHeader />
        <p className="mt-16 text-center text-ink-faint">Loading…</p>
      </div>
    )
  }

  if (error || !recipe) {
    return (
      <div className="min-h-dvh">
        <AppHeader />
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

  return (
    <div className="min-h-dvh">
      <AppHeader title={recipe.title} />

      <main className="pad-safe-bottom mx-auto max-w-3xl px-4 py-5">
        <header className="space-y-3">
          <div>
            <h1 className="font-serif text-3xl leading-tight tracking-tight">
              {recipe.title}
            </h1>
            {recipe.subtitle && (
              <p className="mt-1 text-ink-soft">{recipe.subtitle}</p>
            )}
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

        {recipe.steps.length > 0 && (
          <Link
            to={`/r/${recipe.slug}/cook?x=${scale}`}
            className="mt-6 grid h-14 w-full place-items-center rounded-2xl bg-accent text-lg font-semibold text-white transition active:scale-[0.99] dark:text-stone-900"
          >
            Start cooking →
          </Link>
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
      </main>
    </div>
  )
}
