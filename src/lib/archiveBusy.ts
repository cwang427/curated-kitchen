/**
 * When a link import fails only because the Internet Archive was too busy for
 * us (its "too many requests"), the app waits and tries again by itself, with a
 * countdown, instead of handing the cook an error. Those refusals come and go
 * within minutes, so a few spaced-out tries usually get through.
 *
 * No React/DOM here — pure logic.
 */

/** Seconds to wait before each retry: three more tries over about 2½ minutes,
 * spaced out so each gives the Archive longer to let us back in. */
export const ARCHIVE_BUSY_WAITS = [40, 50, 60]

/** Did this import fail only because the Archive was busy? The Worker marks it
 * with `code: 'archive_busy'` (0.45+); an older Worker only says so in `detail`. */
export function isArchiveBusy(error: unknown): boolean {
  const { code, detail } = (error ?? {}) as { code?: unknown; detail?: unknown }
  return code === 'archive_busy' || (typeof detail === 'string' && detail.startsWith('archive busy'))
}
