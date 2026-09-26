import { Link, useLocation, useNavigate, useParams } from 'react-router-dom'
import AppHeader from '../components/AppHeader'
import RecipeEditor from '../components/RecipeEditor'
import { useAuth } from '../auth/AuthProvider'
import { useRecipe } from '../data/recipes'

/**
 * Edit an existing recipe in place. Loads the recipe, hands it to the same
 * editor used for authoring, and saves back to the same slug — so the URL is
 * stable and the recipe becomes app-owned on save. Members only.
 */
export default function EditRecipePage() {
  const { slug } = useParams<{ slug: string }>()
  const navigate = useNavigate()
  const location = useLocation()
  const { user, household } = useAuth()
  const { recipe, loading, error } = useRecipe(slug)

  if (!user || !household) return null
  const isMember = household.memberUids.includes(user.uid)

  // Leave the editor by stepping back to the recipe page it was opened from,
  // rather than pushing a second copy of it — otherwise Back (or an iOS swipe)
  // from the recipe lands on the stale editor. Opened some other way (a
  // bookmark, a reload), swap the editor out of history instead.
  const cameFromRecipe = (location.state as { fromRecipe?: boolean } | null)?.fromRecipe === true
  const leave = (to: string) => (cameFromRecipe ? navigate(-1) : navigate(`/r/${to}`, { replace: true }))

  return (
    <div className="min-h-dvh">
      <AppHeader title="Edit recipe" back />

      <main className="pad-safe-bottom mx-auto max-w-3xl px-4 py-4">
        {!isMember ? (
          <p className="mt-10 text-center text-ink-soft">
            Only members can edit recipes in this kitchen.
          </p>
        ) : loading ? (
          <p className="mt-10 text-center text-ink-faint">Loading…</p>
        ) : error || !recipe ? (
          <div className="mt-16 space-y-3 text-center">
            <p className="font-serif text-xl">{error ? 'Could not open that recipe' : 'Recipe not found'}</p>
            <Link to="/" className="inline-block text-accent underline">
              Back to all recipes
            </Link>
          </div>
        ) : (
          <RecipeEditor
            initial={recipe}
            editingSlug={recipe.slug}
            onSaved={leave}
            onCancel={() => leave(recipe.slug)}
          />
        )}
      </main>
    </div>
  )
}
