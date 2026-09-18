import { Navigate, Route, Routes } from 'react-router-dom'
import { useAuth } from './auth/AuthProvider'
import SignIn from './auth/SignIn'
import RecipeListPage from './routes/RecipeListPage'
import RecipePage from './routes/RecipePage'

function Loading() {
  return (
    <div className="grid min-h-dvh place-items-center">
      <p className="animate-pulse text-ink-faint">Warming up…</p>
    </div>
  )
}

export default function App() {
  const { user, household, loading, error } = useAuth()

  if (loading) return <Loading />
  if (!user) return <SignIn />

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
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  )
}
