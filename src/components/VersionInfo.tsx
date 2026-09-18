import { useCallback, useEffect, useState } from 'react'

/**
 * Shows which build is running, and — by fetching the un-precached
 * version.json the build emits — whether a newer one has been deployed. This
 * is the manual counterpart to the service worker's background auto-update:
 * useful while testing, when you want to know if the deploy you just pushed is
 * the one on your phone yet.
 */

type Check =
  | { status: 'checking' }
  | { status: 'current' }
  | { status: 'update'; commit: string }
  | { status: 'offline' }

function formatBuildTime(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  return date.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })
}

export default function VersionInfo() {
  const [check, setCheck] = useState<Check>({ status: 'checking' })

  const runCheck = useCallback(async () => {
    setCheck({ status: 'checking' })
    try {
      // Cache-busted and no-store so neither the browser nor the service
      // worker can hand back a stale copy — the whole point is to see the
      // server's current build.
      const response = await fetch(`${import.meta.env.BASE_URL}version.json?t=${Date.now()}`, {
        cache: 'no-store',
      })
      if (!response.ok) throw new Error(String(response.status))
      const deployed = (await response.json()) as { commit?: string }
      setCheck(
        deployed.commit && deployed.commit !== __BUILD__.commit
          ? { status: 'update', commit: deployed.commit }
          : { status: 'current' },
      )
    } catch {
      // Offline, or version.json not present (local dev). Neither is an error
      // worth alarming about.
      setCheck({ status: 'offline' })
    }
  }, [])

  useEffect(() => {
    void runCheck()
  }, [runCheck])

  return (
    <section className="rounded-2xl border border-line bg-card p-4">
      <h3 className="font-medium">Version</h3>
      <p className="mt-1 font-mono text-sm text-ink-soft">
        v{__BUILD__.version} · {__BUILD__.commit}
      </p>
      <p className="text-xs text-ink-faint">Built {formatBuildTime(__BUILD__.time)}</p>

      <div className="mt-3 flex flex-wrap items-center gap-3">
        {check.status === 'checking' && <span className="text-sm text-ink-faint">Checking…</span>}

        {check.status === 'current' && (
          <span className="text-sm text-check">✓ Up to date</span>
        )}

        {check.status === 'offline' && (
          <span className="text-sm text-ink-faint">Couldn’t check for updates</span>
        )}

        {check.status === 'update' && (
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="min-h-11 rounded-full bg-accent px-4 text-sm font-semibold text-white transition active:scale-[0.98] dark:text-stone-900"
          >
            Update available — reload
          </button>
        )}

        {check.status !== 'update' && (
          <button
            type="button"
            onClick={runCheck}
            className="text-sm text-accent underline underline-offset-2"
          >
            Check again
          </button>
        )}
      </div>
    </section>
  )
}
