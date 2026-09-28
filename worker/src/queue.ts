/**
 * The import queue — links a cook asked us to keep trying.
 *
 * When a link import fails in the moment (the AI overloaded, the Internet
 * Archive busy, photos blocked) the cook can queue it and get on with their
 * day. One Durable Object per person holds their queue and wakes itself on a
 * timer (an alarm) to try again — even with the app closed — running the very
 * same import as "Add from URL" (importLink). A finished import waits here;
 * the app, the next time it's open, downloads the photos (a phone can shrink
 * them; the Worker's free plan can't), saves the recipe into the kitchen it
 * was queued for, and tells us it's done. Saving needs the cook's own sign-in,
 * which is why it happens in the app.
 *
 * Retries: 1, 2, 5, 10, 20, 30, 60 min, then hourly, for up to a day. A site
 * that refuses outright (a paywall, NYT Cooking, not a recipe) stops at once.
 * The owner's rule for photos: a recipe that came without them keeps trying
 * for its photos until the day is up, then asks — save it without, or remove.
 *
 * Each item is stored under its own key, so an import in progress (which can
 * take a minute, during which the app may add or remove others) never
 * overwrites a change made meanwhile.
 */
import { importLink, type Env } from './importer'

/** The parts of the Durable Object runtime this uses (SQLite-backed storage,
 * with its key-value interface, and the alarm). */
export interface QueueStorage {
  get<T>(key: string): Promise<T | undefined>
  put(key: string, value: unknown): Promise<void>
  delete(key: string): Promise<boolean>
  list<T>(options: { prefix: string }): Promise<Map<string, T>>
  setAlarm(time: number): Promise<void>
  getAlarm(): Promise<number | null>
  deleteAlarm(): Promise<void>
}
export interface QueueState {
  storage: QueueStorage
}

export type QueueStatus =
  | 'waiting' // to be tried at nextAt
  | 'working' // an import is running now
  | 'ready' // imported; the app will save it
  | 'saving' // an app took it to save (leaseUntil)
  | 'photos-unavailable' // a day of tries brought the recipe but never its photos — ask
  | 'failed' // won't work (or a day went by) — say why
  | 'saved' // in the kitchen (kept a few days so the list can say so)

export interface QueueItem {
  id: string
  url: string
  householdId: string
  addedAt: number
  status: QueueStatus
  attempts: number
  nextAt: number
  /** What happened last, in plain words, for the list. */
  note?: string
  title?: string
  slug?: string
  savedAt?: number
  /** Photos that came through / were wanted, when saved. */
  photos?: { got: number; wanted: number }
  /** The cook chose "save without photos". */
  withoutPhotos?: boolean
  /** A failure trying again can't fix (a paywall, a site that refuses, not a
   * recipe) — the app doesn't offer Try again. */
  final?: boolean
  workingSince?: number
  leaseUntil?: number
}

const MIN = 60_000
const DAY = 24 * 60 * MIN
const WAITS = [1, 2, 5, 10, 20, 30, 60] // minutes, then hourly
const MAX_ACTIVE = 30
/** A link the Worker couldn't open at all, not for a known passing reason —
 * a dead link, say — gets this many tries, not a day's worth. */
const MAX_UNREADABLE = 6

type Importer = (url: string, env: Env) => Promise<{ status: number; body: Record<string, unknown> }>

const reply = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

/** The queue's logic. The Durable Object Cloudflare runs (ImportQueue in
 * index.ts) is a thin wrapper around this, so tests can run it in Node. */
export class QueueCore {
  constructor(
    private readonly state: QueueState,
    private readonly env: Env,
    // Tests swap these for a fake import and a movable clock.
    private readonly run: Importer = importLink,
    private readonly now: () => number = () => Date.now(),
  ) {}

  private key(id: string) {
    return `item:${id}`
  }
  private async items(): Promise<QueueItem[]> {
    return [...(await this.state.storage.list<QueueItem>({ prefix: 'item:' })).values()].sort((a, b) => a.addedAt - b.addedAt)
  }
  private async item(id: unknown): Promise<QueueItem | undefined> {
    return typeof id === 'string' ? this.state.storage.get<QueueItem>(this.key(id)) : undefined
  }
  private async save(item: QueueItem): Promise<void> {
    await this.state.storage.put(this.key(item.id), item)
  }

  /** Wake for the soonest waiting item (or a lease running out), if any. */
  private async schedule(): Promise<void> {
    const times = (await this.items()).flatMap((it) =>
      it.status === 'waiting' ? [it.nextAt] : it.status === 'saving' && it.leaseUntil ? [it.leaseUntil] : [],
    )
    if (!times.length) return void (await this.state.storage.deleteAlarm())
    const next = Math.max(Math.min(...times), this.now() + 1_000)
    const current = await this.state.storage.getAlarm()
    // (An alarm that's firing right now counts as none.)
    if (current === null || current > next || current <= this.now()) await this.state.storage.setAlarm(next)
  }

  /** The app's requests: list, add, take, done, photos-failed, save-failed,
   * without-photos, retry, remove. */
  async fetch(request: Request): Promise<Response> {
    const action = new URL(request.url).pathname.slice(1)
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>
    const now = this.now()

    if (action === 'list') {
      // Saved ones are shown for three days, then tidied away.
      for (const it of await this.items()) {
        if (it.status === 'saved' && now - (it.savedAt ?? 0) > 3 * DAY) await this.state.storage.delete(this.key(it.id))
      }
      return reply({ items: await this.items() })
    }

    if (action === 'add') {
      let url: string
      try {
        const parsed = new URL(String(body.url ?? '').trim())
        if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') throw new Error('scheme')
        url = parsed.toString()
      } catch {
        return reply({ error: 'That doesn’t look like a web link.' }, 400)
      }
      if (typeof body.householdId !== 'string' || !body.householdId) return reply({ error: 'Which kitchen?' }, 400)
      const all = await this.items()
      const active = all.filter((it) => it.status !== 'saved' && it.status !== 'failed')
      const same = active.find((it) => it.url === url && it.householdId === body.householdId)
      if (same) return reply({ item: same, items: all })
      if (active.length >= MAX_ACTIVE) return reply({ error: `The queue holds up to ${MAX_ACTIVE} links at a time.` }, 409)
      const item: QueueItem = {
        id: crypto.randomUUID(),
        url,
        householdId: body.householdId,
        addedAt: now,
        status: 'waiting',
        attempts: 0,
        // Just tried and failed: give it a minute. Queued straight away: now.
        nextAt: body.tried ? now + MIN : now,
        note: body.tried ? 'Couldn’t be read just now' : undefined,
      }
      await this.save(item)
      await this.schedule()
      return reply({ item, items: await this.items() })
    }

    const item = await this.item(body.id)
    if (!item) return reply({ error: 'That link isn’t in the queue any more.' }, 404)

    switch (action) {
      case 'take': {
        // One app at a time saves it: a lease, so two phones can't both save
        // the same recipe, and a phone that vanishes mid-save hands it back.
        if (item.status === 'saving' && (item.leaseUntil ?? 0) > now) return reply({ error: 'Already being saved.' }, 409)
        if (item.status !== 'ready' && item.status !== 'saving') return reply({ error: 'Not ready yet.' }, 409)
        const result = await this.state.storage.get(`result:${item.id}`)
        if (!result) {
          Object.assign(item, { status: 'waiting', nextAt: now, note: 'Trying again' })
          await this.save(item)
          await this.schedule()
          return reply({ error: 'Not ready yet.' }, 409)
        }
        Object.assign(item, { status: 'saving', leaseUntil: now + 5 * MIN })
        await this.save(item)
        await this.schedule()
        return reply({ item, result })
      }
      case 'done': {
        Object.assign(item, {
          status: 'saved',
          savedAt: now,
          slug: typeof body.slug === 'string' ? body.slug : undefined,
          title: typeof body.title === 'string' ? body.title : item.title,
          photos: body.photos && typeof body.photos === 'object' ? body.photos : undefined,
          note: undefined,
          leaseUntil: undefined,
        })
        await this.state.storage.delete(`result:${item.id}`)
        await this.save(item)
        await this.schedule()
        return reply({ item })
      }
      case 'photos-failed': {
        // The recipe came, but none of its photos would download: import it
        // again later (fresh photo links), until the day is up — then ask.
        this.later(item, 'Got the recipe, but not its photos yet', 10 * MIN)
        await this.save(item)
        await this.schedule()
        return reply({ item })
      }
      case 'save-failed': {
        // The app couldn't save it (e.g. no longer a member of that kitchen).
        Object.assign(item, {
          status: 'failed',
          note: typeof body.message === 'string' ? body.message.slice(0, 200) : 'Couldn’t save it to your kitchen.',
          leaseUntil: undefined,
        })
        await this.save(item)
        await this.schedule()
        return reply({ item })
      }
      case 'without-photos': {
        if (item.status !== 'photos-unavailable') return reply({ error: 'Nothing to decide.' }, 409)
        Object.assign(item, { status: 'ready', withoutPhotos: true, note: undefined })
        await this.save(item)
        return reply({ item })
      }
      case 'retry': {
        Object.assign(item, { status: 'waiting', attempts: 0, addedAt: now, nextAt: now, note: 'Trying again', withoutPhotos: undefined, final: undefined })
        await this.save(item)
        await this.schedule()
        return reply({ item })
      }
      case 'remove': {
        await this.state.storage.delete(this.key(item.id))
        await this.state.storage.delete(`result:${item.id}`)
        await this.schedule()
        return reply({ items: await this.items() })
      }
    }
    return reply({ error: 'Unknown queue action.' }, 400)
  }

  /** Try again later — or, once a day has gone by, stop: ask about a recipe
   * that never got its photos, else say it couldn't be imported. */
  private later(item: QueueItem, note: string, atLeast = 0, hasText = false): void {
    const now = this.now()
    if (now - item.addedAt >= DAY) {
      if (hasText || item.status === 'saving' || item.status === 'ready') {
        Object.assign(item, { status: 'photos-unavailable', note: 'The recipe came through, but its photos never did', leaseUntil: undefined })
      } else {
        Object.assign(item, { status: 'failed', note: `${note} — kept trying for a day. Try again later, or paste the recipe text.`, leaseUntil: undefined })
      }
      return
    }
    const wait = WAITS[Math.min(item.attempts - 1, WAITS.length - 1)] ?? 1
    Object.assign(item, { status: 'waiting', nextAt: now + Math.max(wait * MIN, atLeast), note, leaseUntil: undefined })
  }

  /** The alarm: tidy up, then try the item that's most overdue. */
  async alarm(): Promise<void> {
    const started = this.now()
    for (const it of await this.items()) {
      // An import that was running when this copy of the Worker stopped.
      if (it.status === 'working' && started - (it.workingSince ?? 0) > 5 * MIN) {
        Object.assign(it, { status: 'waiting', nextAt: started })
        await this.save(it)
      }
      // A phone that took an item to save and never finished.
      if (it.status === 'saving' && (it.leaseUntil ?? 0) <= started) {
        Object.assign(it, { status: 'ready', leaseUntil: undefined })
        await this.save(it)
      }
    }
    // One import per wake-up: the free plan allows 50 outside requests per
    // run and an import can use about 15. The next due link gets its own
    // wake-up a second later.
    const due = (await this.items()).filter((it) => it.status === 'waiting' && it.nextAt <= this.now()).sort((a, b) => a.nextAt - b.nextAt)[0]
    if (due) await this.attempt(due)
    await this.schedule()
  }

  private async attempt(item: QueueItem): Promise<void> {
    Object.assign(item, { status: 'working', workingSince: this.now(), attempts: item.attempts + 1 })
    await this.save(item)
    let status = 0
    let body: Record<string, unknown> = {}
    try {
      ;({ status, body } = await this.run(item.url, this.env))
    } catch (e) {
      console.log(`queue: import threw ${String(e)}`)
    }
    // The cook may have removed it (or asked to retry) while it ran.
    const now = await this.item(item.id)
    if (!now || now.status !== 'working') return
    const current = now
    const code = typeof body.code === 'string' ? body.code : ''
    const error = typeof body.error === 'string' ? body.error : ''
    const title = (body.recipe as { title?: unknown } | undefined)?.title
    if (typeof title === 'string' && title) current.title = title

    if (status === 200 && !body.photosUnavailable) {
      await this.state.storage.put(`result:${current.id}`, body)
      Object.assign(current, { status: 'ready', note: undefined, workingSince: undefined })
    } else if (status === 200) {
      // The recipe, but not its photos (only Google could read it). Keep the
      // text in case the day runs out, and try again for the photos.
      await this.state.storage.put(`result:${current.id}`, body)
      const atLeast = typeof body.retryAfterMs === 'number' ? body.retryAfterMs : 0
      this.later(current, 'Got the recipe, but not its photos yet', atLeast, true)
    } else if (status === 400 || code === 'site_refuses' || code === 'not_a_recipe' || /paywall/i.test(error) || /didn’t look like a recipe/i.test(error)) {
      Object.assign(current, { status: 'failed', final: true, note: error || 'That link can’t be imported.' })
    } else {
      const hasText = !!(await this.state.storage.get(`result:${current.id}`))
      const known = code === 'ai_busy' || code === 'archive_busy' || status >= 500 || status === 0
      if (!known && current.attempts >= MAX_UNREADABLE) {
        Object.assign(current, { status: hasText ? 'photos-unavailable' : 'failed', note: error || 'Couldn’t open that page.' })
      } else {
        const why =
          code === 'ai_busy'
            ? 'The recipe reader was busy'
            : code === 'archive_busy'
              ? 'The site’s saved copy was busy'
              : status === 0
                ? 'Couldn’t reach the site'
                : 'Couldn’t read it just now'
        const atLeast = typeof body.retryAfterMs === 'number' ? body.retryAfterMs : 0
        this.later(current, why, atLeast, hasText)
      }
    }
    current.workingSince = undefined
    console.log(`queue: ${current.url} → ${current.status}${current.note ? ` (${current.note})` : ''}, attempt ${current.attempts}`)
    await this.save(current)
  }
}
