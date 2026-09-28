/**
 * A link import that failed only because the Internet Archive was busy (it
 * turns requests away for a few minutes at a time) is worth trying again —
 * by the cook, with a "Try again" that unlocks when the Worker says it's worth
 * it. The app never retries by itself: a countdown held friends for minutes
 * with no idea how it would end, and every retry re-ran the whole search.
 *
 * No React/DOM here — pure logic.
 */

/** Did this import fail only because the Archive was busy? The Worker marks it
 * with `code: 'archive_busy'` (0.45+); an older Worker only says so in `detail`. */
export function isArchiveBusy(error: unknown): boolean {
  const { code, detail } = (error ?? {}) as { code?: unknown; detail?: unknown }
  return code === 'archive_busy' || (typeof detail === 'string' && detail.startsWith('archive busy'))
}

/** How long until trying again is worthwhile: the Worker's own estimate (from
 * how recently the Archive refused it), else a minute; never more than 15. */
export function busyRetryMs(error: unknown): number {
  const ms = (error as { retryAfterMs?: unknown } | null)?.retryAfterMs
  return typeof ms === 'number' && ms > 0 ? Math.min(ms, 15 * 60_000) : 60_000
}
