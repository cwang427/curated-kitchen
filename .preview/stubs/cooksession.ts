import type { CookSession } from '../../src/lib/types'

/**
 * Add ?sync to the preview URL to render the "cooking together" state — the
 * join banner on the recipe list, and the synced bar in cook mode. Add ?mine to
 * simulate a session *you* started (banner reads "tap to resume"). Without
 * either, cook mode is solo (the default) and shows the "Cook together" button.
 */
export function useCookSession() {
  const params = new URLSearchParams(window.location.search)
  const mine = params.has('mine')
  if (!params.has('sync') && !mine) return { session: null, loading: false }

  const session: CookSession = {
    householdId: 'hh_preview',
    recipeSlug: 'cacio-e-pepe',
    recipeTitle: 'Cacio e Pepe',
    scale: 2,
    stepIndex: 0,
    timers: [],
    // Preview user's uid is 'u' (see the AuthProvider stub).
    startedBy: mine ? 'u' : 'partner_uid',
    startedByName: mine ? 'Cassidy' : 'Riley',
    updatedAt: null,
    active: true,
  }
  return { session, loading: false }
}

export async function startCookSession() {}
export async function setSessionStep() {}
export async function setSessionTimers() {}
export async function endCookSession() {}
