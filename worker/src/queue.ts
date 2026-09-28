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
import { importJob, type Env, type ImportJob, type Progress, type Stage } from './importer'

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
  /** A link, or pasted text (kept separately, under input:<id>). */
  kind: 'link' | 'text'
  url?: string
  /** For pasted text: its first line, to show in the list. */
  label?: string
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
  /** While importing: how it's getting on (opening, reading, writing…). */
  stage?: Stage
  /** A recipe (without photos) is in hand while it keeps trying for them. */
  hasText?: boolean
}

const MIN = 60_000
const DAY = 24 * 60 * MIN
const WAITS = [1, 2, 5, 10, 20, 30, 60] // minutes, then hourly
const MAX_ACTIVE = 30
/** A link the Worker couldn't open at all, not for a known passing reason —
 * a dead link, say — gets this many tries, not a day's worth. */
const MAX_UNREADABLE = 6

type Importer = (job: ImportJob, env: Env, report: Progress) => Promise<{ status: number; body: Record<string, unknown> }>
/** The longest pasted text the queue keeps (a recipe page's text is far less). */
const MAX_TEXT = 200_000

const reply = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

/** The queue's logic. The Durable Object Cloudflare runs (ImportQueue in
 * index.ts) is a thin wrapper around this, so tests can run it in Node. */
export class QueueCore {
  /** Whose queue this is (their sign-in id, from the Worker), so it can ask
   * their notifier to tell them when a recipe is ready. */
  private owner: string | null = null
  /** When the app last asked about the queue: an app that's open (it checks
   * every couple of seconds while something's importing) shows the news
   * itself, so no notification then. */
  private lastSeen = 0

  constructor(
    private readonly state: QueueState,
    private readonly env: Env,
    // Tests swap these for a fake import and a movable clock.
    private readonly run: Importer = importJob,
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
    this.lastSeen = now
    const uid = request.headers.get('X-Uid')
    if (uid && uid !== this.owner) {
      this.owner = uid
      await this.state.storage.put('owner', uid)
    }

    if (action === 'list') {
      // Saved ones are shown for three days, then tidied away.
      for (const it of await this.items()) {
        if (it.status === 'saved' && now - (it.savedAt ?? 0) > 3 * DAY) await this.state.storage.delete(this.key(it.id))
      }
      // `text`: this queue takes pasted text too (0.50+), so the app can tell.
      return reply({ items: await this.items(), text: true })
    }

    if (action === 'add') {
      let url: string | undefined
      const text = typeof body.text === 'string' ? body.text.trim() : ''
      if (text) {
        if (text.length > MAX_TEXT) return reply({ error: 'That’s too much text for one recipe.' }, 400)
      } else {
        try {
          const parsed = new URL(String(body.url ?? '').trim())
          if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') throw new Error('scheme')
          url = parsed.toString()
        } catch {
          return reply({ error: 'That doesn’t look like a web link.' }, 400)
        }
      }
      if (typeof body.householdId !== 'string' || !body.householdId) return reply({ error: 'Which kitchen?' }, 400)
      const all = await this.items()
      const active = all.filter((it) => it.status !== 'saved' && it.status !== 'failed')
      const same = url && active.find((it) => it.url === url && it.householdId === body.householdId)
      if (same) return reply({ item: same, items: all })
      if (active.length >= MAX_ACTIVE) return reply({ error: `The queue holds up to ${MAX_ACTIVE} imports at a time.` }, 409)
      const id = crypto.randomUUID()
      if (text) await this.state.storage.put(`input:${id}`, text)
      const item: QueueItem = {
        id,
        kind: text ? 'text' : 'link',
        ...(url ? { url } : { label: text.split('\n').find((l) => l.trim())?.trim().slice(0, 80) ?? 'Pasted recipe' }),
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
        // Pasted text comes back too: the app checks the recipe's source link
        // against it (the AI can invent one).
        const text = item.kind === 'text' ? await this.state.storage.get<string>(`input:${item.id}`) : undefined
        return reply({ item, result, ...(text ? { text } : {}) })
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
        await this.state.storage.delete(`input:${item.id}`)
        await this.save(item)
        await this.schedule()
        return reply({ item })
      }
      case 'photos-failed': {
        // The recipe came, but none of its photos would download: import it
        // again later (fresh photo links), until the day is up — then ask.
        item.hasText = true
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
        // Any time a recipe is in hand while it's still trying for photos —
        // not only once the day is up — the cook may take it without them.
        const hasResult = !!(await this.state.storage.get(`result:${item.id}`))
        if (!hasResult || !['photos-unavailable', 'waiting', 'ready'].includes(item.status)) {
          return reply({ error: 'Nothing to decide.' }, 409)
        }
        Object.assign(item, { status: 'ready', withoutPhotos: true, note: undefined, stage: undefined })
        await this.save(item)
        await this.schedule()
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
        await this.state.storage.delete(`input:${item.id}`)
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
    Object.assign(item, { status: 'working', workingSince: this.now(), attempts: item.attempts + 1, stage: undefined })
    await this.save(item)
    let status = 0
    let body: Record<string, unknown> = {}
    // Progress, as it happens, onto the item for the app to show — one write
    // at a time, and never bringing back an item removed meanwhile.
    let writing = Promise.resolve()
    const report: Progress = (stage) => {
      writing = writing.then(async () => {
        const cur = await this.item(item.id)
        if (cur?.status !== 'working') return
        cur.stage = stage
        await this.save(cur)
      })
    }
    try {
      const text = item.kind === 'text' ? await this.state.storage.get<string>(`input:${item.id}`) : undefined
      const job: ImportJob | null = item.kind === 'text' ? (text ? { text } : null) : item.url ? { url: item.url } : null
      if (job) ({ status, body } = await this.run(job, this.env, report))
      else ({ status, body } = { status: 400, body: { error: 'Nothing to import.' } })
    } catch (e) {
      console.log(`queue: import threw ${String(e)}`)
    }
    await writing
    // The cook may have removed it (or asked to retry) while it ran.
    const now = await this.item(item.id)
    if (!now || now.status !== 'working') return
    const current = now
    current.stage = undefined
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
      current.hasText = true
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
    console.log(`queue: ${current.url ?? `text "${current.label}"`} → ${current.status}${current.note ? ` (${current.note})` : ''}, attempt ${current.attempts}`)
    await this.save(current)
    await this.announce(current)
  }

  /** Tell the cook, on their phone, when an import is ready — or needs them —
   * unless the app is open and showing it already. */
  private async announce(item: QueueItem): Promise<void> {
    if (this.now() - this.lastSeen < 20_000) return
    const name = item.title ?? item.label ?? (item.url ? new URL(item.url).hostname.replace(/^www\./, '') : 'Your recipe')
    const message =
      item.status === 'ready'
        ? { title: 'Ready for review', body: `${name} — take a look and add it to your kitchen.` }
        : item.status === 'photos-unavailable'
          ? { title: 'A recipe needs you', body: `${name} came through, but its photos never did. Save it without them?` }
          : item.status === 'failed'
            ? { title: 'Couldn’t import a recipe', body: `${name}: ${item.note ?? 'it couldn’t be read'}` }
            : null
    if (!message || !this.env.NOTIFY) return
    const owner = this.owner ?? (await this.state.storage.get<string>('owner')) ?? null
    if (!owner) return
    try {
      const notifier = this.env.NOTIFY.get(this.env.NOTIFY.idFromName(owner))
      const res = await notifier.fetch(
        new Request('https://notify/send', {
          method: 'POST',
          headers: { 'X-Internal': '1' },
          body: JSON.stringify({ ...message, tag: `import-${item.id}`, path: 'add' }),
        }),
      )
      await res.body?.cancel()
    } catch (e) {
      console.log(`queue: couldn’t notify — ${String(e)}`)
    }
  }
}
