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
  const [applying, setApplying] = useState(false)

  const [note, setNote] = useState<string | null>(null)

  // A plain reload isn't enough for a PWA: a freshly deployed service worker
  // has to install and take control first, otherwise the reload just re-serves
  // the old cached app. So fetch the new worker and reload only once it's in
  // control. Installing means downloading the whole new build — seconds on
  // wifi, far longer on weak cell service — so wait for it to finish rather
  // than reloading on a timer (that reloaded into the old version mid-download,
  // which is why a second tap used to be needed).
  const applyUpdate = useCallback(async () => {
    setApplying(true)
    setNote(null)
    let reloaded = false
    const reload = () => {
      if (reloaded) return
      reloaded = true
      window.location.reload()
    }
    try {
      if (!('serviceWorker' in navigator)) return reload()
      const reg = await navigator.serviceWorker.getRegistration()
      if (!reg) return reload()
      // The new worker taking control is the real signal it's safe to reload.
      // Left attached on purpose: if the download outlasts our wait below, the
      // app still switches over by itself once it lands.
      navigator.serviceWorker.addEventListener('controllerchange', reload, { once: true })
      await reg.update()
      let incoming = reg.installing ?? reg.waiting
      if (!incoming) {
        // Some browsers resolve update() a beat before the new worker appears.
        incoming = await new Promise<ServiceWorker | null>((resolve) => {
          const timer = setTimeout(() => resolve(null), 3000)
          reg.addEventListener(
            'updatefound',
            () => {
              clearTimeout(timer)
              resolve(reg.installing)
            },
            { once: true },
          )
        })
      }
      // Nothing new to install: the latest build already finished in the
      // background, so a plain reload picks it up.
      if (!incoming) return reload()
      const worker = incoming
      // autoUpdate workers skip waiting on their own; the nudge is harmless.
      const nudge = () => reg.waiting?.postMessage({ type: 'SKIP_WAITING' })
      nudge()
      worker.addEventListener('statechange', () => {
        if (worker.state === 'installed') nudge()
        else if (worker.state === 'activated') reload()
        else if (worker.state === 'redundant' && !reloaded) {
          setApplying(false)
          setNote('The update didn’t finish downloading — check your connection and try again.')
        }
      })
      setTimeout(() => {
        if (reloaded) return
        setApplying(false)
        setNote('Still downloading on this connection. It’ll switch over by itself when it’s done, or try again in a minute.')
      }, 60_000)
    } catch {
      reload()
    }
  }, [])

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
            onClick={applyUpdate}
            disabled={applying}
            className="min-h-11 rounded-full bg-accent px-4 text-sm font-semibold text-white transition active:scale-[0.98] disabled:opacity-60 dark:text-stone-900"
          >
            {applying ? 'Downloading update…' : 'Update available — reload'}
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
      {note && <p className="mt-2 text-sm text-ink-soft">{note}</p>}
    </section>
  )
}
