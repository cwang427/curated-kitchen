import { useState, type FormEvent } from 'react'
import { useAuth } from './AuthProvider'

export default function SignIn() {
  const { signIn, submitting, error } = useAuth()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')

  const onSubmit = (event: FormEvent) => {
    event.preventDefault()
    if (!email || !password || submitting) return
    void signIn(email, password)
  }

  return (
    <div className="flex min-h-dvh flex-col items-center justify-center px-6">
      <div className="w-full max-w-sm">
        <div className="space-y-2 text-center">
          <h1 className="font-serif text-4xl tracking-tight">Curated Kitchen</h1>
          <p className="text-balance text-sm text-ink-soft">
            Recipes, a cooking companion, and the grocery list — shared with the
            people you cook with.
          </p>
        </div>

        {/*
          A real <form> so the keyboard's Go button submits, and the
          autoComplete values iCloud Keychain looks for so it offers to save
          the password once and fills it with Face ID after that.
        */}
        <form onSubmit={onSubmit} className="mt-10 space-y-4">
          <div className="space-y-1.5">
            <label htmlFor="email" className="block text-sm font-medium text-ink-soft">
              Email
            </label>
            <input
              id="email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoComplete="username"
              inputMode="email"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              required
              disabled={submitting}
              className="min-h-12 w-full rounded-xl border border-line bg-card px-4 text-base outline-none focus:border-accent disabled:opacity-60"
            />
          </div>

          <div className="space-y-1.5">
            <label htmlFor="password" className="block text-sm font-medium text-ink-soft">
              Password
            </label>
            <input
              id="password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
              required
              disabled={submitting}
              aria-describedby={error ? 'signin-error' : undefined}
              className="min-h-12 w-full rounded-xl border border-line bg-card px-4 text-base outline-none focus:border-accent disabled:opacity-60"
            />
          </div>

          <button
            type="submit"
            disabled={submitting || !email || !password}
            className="min-h-12 w-full rounded-xl bg-accent text-base font-semibold text-white transition active:scale-[0.99] disabled:opacity-50 dark:text-stone-900"
          >
            {submitting ? 'Signing in…' : 'Sign in'}
          </button>

          {error && (
            <p
              id="signin-error"
              role="alert"
              className="text-center text-sm text-red-600 dark:text-red-400"
            >
              {error}
            </p>
          )}
        </form>

        <p className="mt-8 text-center text-xs text-ink-faint">
          Accounts are created in the Firebase console — there's no sign-up here.
        </p>
      </div>
    </div>
  )
}
