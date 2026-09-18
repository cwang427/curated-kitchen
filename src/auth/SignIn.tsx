import { useAuth } from './AuthProvider'

export default function SignIn() {
  const { signIn, error } = useAuth()

  return (
    <div className="flex min-h-dvh flex-col items-center justify-center gap-8 px-6 text-center">
      <div className="space-y-3">
        <h1 className="font-serif text-4xl tracking-tight">Curated Kitchen</h1>
        <p className="mx-auto max-w-sm text-balance text-ink-soft">
          Your recipes, a cooking companion, and the grocery list — shared with
          the people you cook with.
        </p>
      </div>

      <button
        type="button"
        onClick={signIn}
        className="flex min-h-12 items-center gap-3 rounded-full border border-line bg-card px-6 text-base font-medium shadow-sm transition active:scale-[0.98]"
      >
        <svg className="size-5" viewBox="0 0 24 24" aria-hidden="true">
          <path
            fill="#4285F4"
            d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.76h3.57c2.08-1.92 3.28-4.74 3.28-8.09Z"
          />
          <path
            fill="#34A853"
            d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.76c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84A11 11 0 0 0 12 23Z"
          />
          <path
            fill="#FBBC05"
            d="M5.84 14.11a6.6 6.6 0 0 1 0-4.22V7.05H2.18a11 11 0 0 0 0 9.9l3.66-2.84Z"
          />
          <path
            fill="#EA4335"
            d="M12 4.75c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 1.46 14.97.5 12 .5A11 11 0 0 0 2.18 7.05l3.66 2.84c.87-2.6 3.3-4.14 6.16-4.14Z"
          />
        </svg>
        Continue with Google
      </button>

      {error && (
        <p role="alert" className="max-w-sm text-sm text-red-600 dark:text-red-400">
          {error}
        </p>
      )}
    </div>
  )
}
