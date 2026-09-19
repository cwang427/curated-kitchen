import { Link, useNavigate, useParams } from 'react-router-dom'
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
  const { user, household } = useAuth()
  const { recipe, loading, error } = useRecipe(slug)

  if (!user || !household) return null
  const isMember = household.memberUids.includes(user.uid)

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
            onSaved={(saved) => navigate(`/r/${saved}`)}
            onCancel={() => navigate(`/r/${recipe.slug}`)}
          />
        )}
      </main>
    </div>
  )
}
