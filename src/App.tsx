import { Navigate, Route, Routes, useSearchParams } from 'react-router-dom'
import { useAuth } from './auth/AuthProvider'
import SignIn from './auth/SignIn'
import RecipeListPage from './routes/RecipeListPage'
import RecipePage from './routes/RecipePage'
import CookPage from './routes/CookPage'
import CookingPage from './routes/CookingPage'
import GroceryListPage from './routes/GroceryListPage'
import PlanPage from './routes/PlanPage'
import AddRecipePage from './routes/AddRecipePage'
import EditRecipePage from './routes/EditRecipePage'
import SettingsPage from './routes/SettingsPage'
import JoinPage from './routes/JoinPage'

function Loading() {
  return (
    <div className="grid min-h-dvh place-items-center">
      <p className="animate-pulse text-ink-faint">Warming up…</p>
    </div>
  )
}

export default function App() {
  const { user, household, loading, error } = useAuth()
  // Invite links land at the app root with ?join=<code>, so it has to be
  // handled ahead of the normal routes — before we require a loaded household.
  const [params] = useSearchParams()
  const joinCode = params.get('join')

  if (loading) return <Loading />
  if (!user) return <SignIn />

  // A signed-in user opening an invite link goes straight to the prompt,
  // even while their own household is still loading.
  if (joinCode) return <JoinPage />

  if (error) {
    return (
      <div className="grid min-h-dvh place-items-center px-6">
        <p role="alert" className="max-w-sm text-center text-ink-soft">
          {error}
        </p>
      </div>
    )
  }

  if (!household) return <Loading />

  return (
    <Routes>
      <Route path="/" element={<RecipeListPage />} />
      <Route path="/r/:slug" element={<RecipePage />} />
      <Route path="/r/:slug/cook" element={<CookPage />} />
      <Route path="/cooking" element={<CookingPage />} />
      <Route path="/list" element={<GroceryListPage />} />
      <Route path="/plan" element={<PlanPage />} />
      <Route path="/add" element={<AddRecipePage />} />
      <Route path="/r/:slug/edit" element={<EditRecipePage />} />
      <Route path="/settings" element={<SettingsPage />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  )
}
