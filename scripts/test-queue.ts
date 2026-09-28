/**
 * Tests for the import queue's Durable Object (worker/src/queue.ts): adding,
 * the retry schedule, what counts as "try again" vs "stop", the photo rule,
 * handing a finished import to the app and back, and alarms — with a fake
 * storage, a fake import and a clock we move by hand.
 *
 *   npm run test:queue
 */
import { QueueCore as ImportQueue, type QueueItem, type QueueStorage } from '../worker/src/queue'

const realLog = console.log
let passed = 0
let failed = 0
function check(label: string, cond: boolean, detail?: unknown): void {
  if (cond) {
    realLog(`  ✓ ${label}`)
    passed++
  } else {
    console.error(`  ✗ ${label}${detail === undefined ? '' : `: ${JSON.stringify(detail).slice(0, 500)}`}`)
    failed++
  }
}
const MIN = 60_000

/** A Durable Object's storage, in memory. */
function fakeStorage(): QueueStorage & { alarm: number | null; data: Map<string, unknown> } {
  const data = new Map<string, unknown>()
  const s = {
    data,
    alarm: null as number | null,
    async get<T>(key: string) {
      return structuredClone(data.get(key)) as T | undefined
    },
    async put(key: string, value: unknown) {
      data.set(key, structuredClone(value))
    },
    async delete(key: string) {
      return data.delete(key)
    },
    async list<T>({ prefix }: { prefix: string }) {
      return new Map([...data].filter(([k]) => k.startsWith(prefix)).map(([k, v]) => [k, structuredClone(v) as T]))
    },
    async setAlarm(time: number) {
      s.alarm = time
    },
    async getAlarm() {
      return s.alarm
    },
    async deleteAlarm() {
      s.alarm = null
    },
  }
  return s
}

type Outcome = { status: number; body: Record<string, unknown> }
const OK: Outcome = { status: 200, body: { recipe: { title: 'Corn Chowder' }, photos: { cover: 'https://x/c.jpg', steps: {} }, via: 'direct' } }
const TEXT_ONLY: Outcome = { status: 200, body: { recipe: { title: 'Corn Chowder' }, via: 'google-archive', photosUnavailable: true, retryAfterMs: 90_000 } }
const AI_BUSY: Outcome = { status: 502, body: { code: 'ai_busy', error: 'overloaded' } }
const ARCHIVE_BUSY: Outcome = { status: 422, body: { code: 'archive_busy', error: 'busy', retryAfterMs: 5 * MIN } }
const NYT: Outcome = { status: 422, body: { code: 'site_refuses', error: 'NYT Cooking recipes are for subscribers only…' } }
const DEAD: Outcome = { status: 422, body: { error: 'Couldn’t open that page — copy the recipe text instead.' } }

function setup(outcomes: Outcome[]) {
  let clock = Date.UTC(2026, 8, 28, 20, 0)
  const storage = fakeStorage()
  const runs: string[] = []
  const queue = new ImportQueue(
    { storage },
    {} as never,
    async (url) => {
      runs.push(url)
      return structuredClone(outcomes.length > 1 ? outcomes.shift()! : outcomes[0])
    },
    () => clock,
  )
  const call = async (action: string, body: Record<string, unknown> = {}) => {
    const res = await queue.fetch(new Request(`https://queue/${action}`, { method: 'POST', body: JSON.stringify(body) }))
    return { status: res.status, body: (await res.json()) as { item?: QueueItem; items?: QueueItem[]; result?: unknown; error?: string } }
  }
  /** Move the clock to the alarm (if it's set) and run it. */
  const tick = async () => {
    if (storage.alarm === null) return false
    clock = Math.max(clock, storage.alarm)
    storage.alarm = null // a fired alarm is gone, as in the real thing
    await queue.alarm()
    return true
  }
  const advance = (ms: number) => (clock += ms)
  const item = async (id: string) => (await call('list')).body.items!.find((it) => it.id === id)!
  return { queue, storage, runs, call, tick, advance, item, now: () => clock }
}

console.log = () => {} // the queue's own log lines
const log = (s: string) => realLog(s)

log('adding')
{
  const q = setup([OK])
  const a = await q.call('add', { url: 'https://www.seriouseats.com/corn-chowder', householdId: 'h1', tried: true })
  check('added, waiting, first try in a minute (it just failed)', a.body.item?.status === 'waiting' && a.body.item.nextAt === q.now() + MIN)
  check('alarm set for that minute', q.storage.alarm === q.now() + MIN)
  const again = await q.call('add', { url: 'https://www.seriouseats.com/corn-chowder', householdId: 'h1' })
  check('the same link again → the same item, not a second', again.body.item?.id === a.body.item?.id && (await q.call('list')).body.items!.length === 1)
  const fresh = await q.call('add', { url: 'https://smallblog.example/soup', householdId: 'h1' })
  check('queued without trying first → tried straight away', fresh.body.item?.nextAt === q.now())
  check('a bad link is refused', (await q.call('add', { url: 'not a link', householdId: 'h1' })).status === 400)
  check('a kitchen is required', (await q.call('add', { url: 'https://x.example/' })).status === 400)
}

log('a busy AI, then success')
{
  const q = setup([AI_BUSY, AI_BUSY, OK])
  const { item } = (await q.call('add', { url: 'https://s.example/r', householdId: 'h1', tried: true })).body
  await q.tick()
  let it = await q.item(item!.id)
  check('1st try busy → waiting, next in 1 min, says why', it.status === 'waiting' && it.nextAt === q.now() + MIN && it.note === 'The recipe reader was busy', it)
  await q.tick()
  it = await q.item(item!.id)
  check('2nd try busy → next in 2 min', it.status === 'waiting' && it.nextAt === q.now() + 2 * MIN, it)
  await q.tick()
  it = await q.item(item!.id)
  check('3rd try works → ready, with its title', it.status === 'ready' && it.title === 'Corn Chowder', it)
  check('…no alarm left (nothing waiting)', q.storage.alarm === null)
  check('three imports run in all', q.runs.length === 3)
}

log('the Archive busy: waits at least as long as it asked')
{
  const q = setup([ARCHIVE_BUSY, OK])
  const { item } = (await q.call('add', { url: 'https://s.example/r', householdId: 'h1', tried: true })).body
  await q.tick()
  const it = await q.item(item!.id)
  check('next try after the 5 min the Worker estimated, not 1', it.nextAt === q.now() + 5 * MIN && /saved copy was busy/.test(it.note ?? ''), it)
}

log('sites that won’t work stop at once')
{
  const q = setup([NYT])
  const { item } = (await q.call('add', { url: 'https://cooking.nytimes.com/r', householdId: 'h1' })).body
  await q.tick()
  const it = await q.item(item!.id)
  check('NYT → failed with its message, no more tries', it.status === 'failed' && /subscribers/.test(it.note ?? '') && q.storage.alarm === null, it)
  check('…marked final (no Try again offered)', it.final === true)
}
{
  const q = setup([DEAD])
  const { item } = (await q.call('add', { url: 'https://gone.example/r', householdId: 'h1' })).body
  for (let i = 0; i < 10; i++) await q.tick()
  const it = await q.item(item!.id)
  check('an unreadable link gets 6 tries, not a day of them', it.status === 'failed' && q.runs.length === 6, { status: it.status, runs: q.runs.length })
  check('…not final (the page may come back): Try again stays', !it.final)
}

log('a day of retries, then it stops')
{
  const q = setup([AI_BUSY])
  const { item } = (await q.call('add', { url: 'https://s.example/r', householdId: 'h1', tried: true })).body
  let ticks = 0
  while ((await q.tick()) && ticks < 200) ticks++
  const it = await q.item(item!.id)
  const gaps = [1, 2, 5, 10, 20, 30, 60]
  check('gave up after a day, saying why and what to do', it.status === 'failed' && /kept trying for a day/.test(it.note ?? ''), it)
  check('…with the gaps growing to hourly (about 27 tries)', q.runs.length >= 25 && q.runs.length <= 30 && gaps.length === 7, q.runs.length)
}

log('photos: keep trying, then ask')
{
  const q = setup([TEXT_ONLY])
  const { item } = (await q.call('add', { url: 'https://s.example/r', householdId: 'h1', tried: true })).body
  await q.tick()
  let it = await q.item(item!.id)
  check('recipe without photos → keeps trying (waits the 90 s it was told)', it.status === 'waiting' && it.nextAt === q.now() + 90_000 && /not its photos/.test(it.note ?? ''), it)
  for (let n = 0; n < 200 && (await q.tick()); n++) {}
  it = await q.item(item!.id)
  check('after a day of photo-less results → asks', it.status === 'photos-unavailable', it)
  check('"save without photos" → ready, marked so', (await q.call('without-photos', { id: item!.id })).body.item?.status === 'ready' && (await q.item(item!.id)).withoutPhotos === true)
  const taken = await q.call('take', { id: item!.id })
  check('…and the app can take the text-only recipe', taken.status === 200 && !!taken.body.result)
}
{
  // Photos came with the import, but the phone couldn't download any.
  const q = setup([OK])
  const { item } = (await q.call('add', { url: 'https://s.example/r', householdId: 'h1' })).body
  await q.tick()
  await q.call('take', { id: item!.id })
  await q.call('photos-failed', { id: item!.id })
  const it = await q.item(item!.id)
  check('photos wouldn’t download → imported again later (≥10 min)', it.status === 'waiting' && it.nextAt >= q.now() + 10 * MIN, it)
}

log('handing a finished import to the app')
{
  const q = setup([OK])
  const { item } = (await q.call('add', { url: 'https://s.example/r', householdId: 'h1' })).body
  check('not ready yet → can’t take', (await q.call('take', { id: item!.id })).status === 409)
  await q.tick()
  const taken = await q.call('take', { id: item!.id })
  check('take → the import, and the item is being saved (leased)', taken.status === 200 && (taken.body.result as { via?: string }).via === 'direct' && taken.body.item?.status === 'saving')
  check('a second phone can’t take it meanwhile', (await q.call('take', { id: item!.id })).status === 409)
  const done = await q.call('done', { id: item!.id, slug: 'corn-chowder-ab12c', title: 'The Best Corn Chowder', photos: { got: 6, wanted: 6 } })
  check('done → saved, with its link and photo count', done.body.item?.status === 'saved' && done.body.item.slug === 'corn-chowder-ab12c' && done.body.item.photos?.got === 6)
  check('…and the stored import is deleted', !q.storage.data.has(`result:${item!.id}`))
  q.advance(4 * 24 * 60 * MIN)
  check('saved items are tidied from the list after 3 days', (await q.call('list')).body.items!.length === 0)
}
{
  // A phone takes it and vanishes: after 5 minutes it's ready again.
  const q = setup([OK])
  const { item } = (await q.call('add', { url: 'https://s.example/r', householdId: 'h1' })).body
  await q.tick()
  await q.call('take', { id: item!.id })
  check('an alarm is set for the lease', q.storage.alarm !== null)
  await q.tick()
  check('lease ran out → ready again for another phone', (await q.item(item!.id)).status === 'ready')
}
{
  const q = setup([OK])
  const { item } = (await q.call('add', { url: 'https://s.example/r', householdId: 'h1' })).body
  await q.tick()
  await q.call('take', { id: item!.id })
  await q.call('save-failed', { id: item!.id, message: 'You’re no longer a member of that kitchen.' })
  const it = await q.item(item!.id)
  check('the app couldn’t save it → failed, with the reason', it.status === 'failed' && /no longer a member/.test(it.note ?? ''))
  await q.call('retry', { id: item!.id })
  check('Try again → waiting, due now, a fresh day', (await q.item(item!.id)).status === 'waiting' && (await q.item(item!.id)).nextAt === q.now())
  await q.call('remove', { id: item!.id })
  check('Remove → gone', (await q.call('list')).body.items!.length === 0)
}

log('removing while an import runs')
{
  const q = setup([OK])
  const { item } = (await q.call('add', { url: 'https://s.example/r', householdId: 'h1' })).body
  // Remove it from inside the import (as if the cook tapped Remove meanwhile).
  const slow = new ImportQueue(
    { storage: q.storage },
    {} as never,
    async () => {
      await q.call('remove', { id: item!.id })
      return OK
    },
    q.now,
  )
  await slow.alarm()
  check('the finished import doesn’t bring it back', (await q.call('list')).body.items!.length === 0 && !q.storage.data.has(`result:${item!.id}`))
}

log('several links, one at a time')
{
  const q = setup([OK])
  for (const n of [1, 2, 3]) await q.call('add', { url: `https://s.example/${n}`, householdId: 'h1' })
  await q.tick()
  check('one import per wake-up (the free plan’s request limit)', q.runs.length === 1)
  check('…the next wakes a second later', q.storage.alarm === q.now() + 1_000, q.storage.alarm! - q.now())
  while (await q.tick()) {}
  const items = (await q.call('list')).body.items!
  check('all three imported, in the order queued', items.every((it) => it.status === 'ready') && q.runs.join() === 'https://s.example/1,https://s.example/2,https://s.example/3', q.runs)
}

console.log = realLog
console.log(`\n${passed} passed, ${failed} failed`)
if (failed) (globalThis as { process?: { exit(code: number): never } }).process?.exit(1)
