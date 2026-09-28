/**
 * Notifications — one Durable Object per person (the Notifier in index.ts),
 * separate from their import queue so a timer alert never waits behind an
 * import that's running (a Durable Object runs one alarm at a time, and an
 * import can take a minute or more).
 *
 * It keeps:
 *  - the VAPID key pair its pushes are signed with (made the first time it's
 *    needed — nothing for the owner to set up);
 *  - each of the person's devices that turned notifications on
 *    (`device:<id>` = the browser's push subscription);
 *  - each device's running kitchen timers (`timers:<id>`), so a timer that
 *    runs out while the app is closed still alerts: the alarm sends the push
 *    a couple of seconds after it rings (the app, if it's open, rang it
 *    itself and has already taken it off the list).
 *
 * The import queue asks it (`send`, from inside the Worker only) to tell the
 * person a recipe is ready for review.
 */
import type { Env } from './importer'
import { makeVapidKeys, sendPush, type PushMessage, type PushSubscriptionJSON, type VapidKeys } from './push'
import type { QueueState } from './queue'

/** Who the pushes are from (VAPID's contact), and where a tap lands. */
export const APP_URL = 'https://cwang427.github.io/curated-kitchen/'

export interface TimerAlert {
  id: string
  /** When it rings (server time, ms). */
  at: number
  /** The notification when it rings: "Simmer — time's up". */
  title: string
  body: string
  /** Its line in the "timers running" note: "Simmer · Corn chowder — rings 6:42". */
  line: string
  /** The app page to open (cook mode for that dish). */
  path?: string
}

interface Device {
  subscription: PushSubscriptionJSON
  addedAt: number
}

/** The push services browsers use (Apple, Google, Mozilla, Microsoft) — the
 * only places this sends to. */
const PUSH_HOSTS = [/\.push\.apple\.com$/, /^fcm\.googleapis\.com$/, /\.mozilla\.com$/, /\.notify\.windows\.com$/]

/** A timer's push goes out this long after it rings, so an app that's open
 * (and rang it itself) has time to take it off the list first. */
const RING_GRACE_MS = 2_000
const MAX_DEVICES = 10
const MAX_TIMERS = 20

const reply = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

const text = (v: unknown, max: number): string => (typeof v === 'string' ? v.trim().slice(0, max) : '')

type Sender = typeof sendPush

export class NotifyCore {
  constructor(
    private readonly state: QueueState,
    // (The Worker's settings; nothing here needs them yet.)
    _env: Env,
    // Tests swap these for a fake push service and a movable clock.
    private readonly send: Sender = sendPush,
    private readonly now: () => number = () => Date.now(),
  ) {}

  private async keys(): Promise<VapidKeys> {
    let keys = await this.state.storage.get<VapidKeys>('vapid')
    if (!keys) {
      keys = await makeVapidKeys()
      await this.state.storage.put('vapid', keys)
    }
    return keys
  }

  private async devices(): Promise<Map<string, Device>> {
    const out = new Map<string, Device>()
    for (const [key, device] of await this.state.storage.list<Device>({ prefix: 'device:' })) out.set(key.slice(7), device)
    return out
  }

  /** Push to one device; a subscription the push service says is gone (the
   * app removed, notifications turned off) is forgotten, with its timers. */
  private async push(deviceId: string, device: Device, message: PushMessage, urgency: 'normal' | 'high' = 'normal', ttl = 3600) {
    const result = await this.send(device.subscription, message, await this.keys(), { subject: APP_URL, ttl, urgency })
    if (result === 'gone') {
      console.log(`notify: device ${deviceId.slice(0, 8)} is gone — forgetting it`)
      await this.state.storage.delete(`device:${deviceId}`)
      await this.state.storage.delete(`timers:${deviceId}`)
    }
    return result
  }

  /** Wake for the next timer to ring, if any. */
  private async schedule(): Promise<void> {
    const times = [...(await this.state.storage.list<TimerAlert[]>({ prefix: 'timers:' })).values()].flat().map((t) => t.at + RING_GRACE_MS)
    if (!times.length) return void (await this.state.storage.deleteAlarm())
    const next = Math.max(Math.min(...times), this.now() + 250)
    const current = await this.state.storage.getAlarm()
    if (current === null || current > next || current <= this.now()) await this.state.storage.setAlarm(next)
  }

  /** The app's requests: key, subscribe, unsubscribe, timers, test — and
   * `send`, from the import queue inside the Worker. */
  async fetch(request: Request): Promise<Response> {
    const action = new URL(request.url).pathname.slice(1)
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>
    const deviceId = text(body.deviceId, 64)

    if (action === 'key') return reply({ publicKey: (await this.keys()).publicKey })

    if (action === 'send') {
      if (request.headers.get('X-Internal') !== '1') return reply({ error: 'Unknown action.' }, 404)
      const message: PushMessage = {
        title: text(body.title, 120) || 'Curated Kitchen',
        body: text(body.body, 300),
        tag: text(body.tag, 80) || undefined,
        path: text(body.path, 200) || undefined,
        kind: 'review',
      }
      let sent = 0
      for (const [id, device] of await this.devices()) if ((await this.push(id, device, message)) === 'sent') sent++
      return reply({ sent })
    }

    if (!/^[A-Za-z0-9_-]{8,64}$/.test(deviceId)) return reply({ error: 'Which device?' }, 400)

    switch (action) {
      case 'subscribe': {
        const sub = body.subscription as PushSubscriptionJSON | undefined
        let host = ''
        try {
          const url = new URL(String(sub?.endpoint ?? ''))
          if (url.protocol === 'https:') host = url.hostname
        } catch {
          /* not a URL */
        }
        if (!host || !PUSH_HOSTS.some((h) => h.test(host)) || typeof sub?.keys?.p256dh !== 'string' || typeof sub?.keys?.auth !== 'string') {
          return reply({ error: 'This browser’s notification service isn’t supported.' }, 400)
        }
        const devices = await this.devices()
        // A person with a pile of old phones: keep the newest few.
        const others = [...devices].filter(([id]) => id !== deviceId).sort((a, b) => b[1].addedAt - a[1].addedAt)
        for (const [id] of others.slice(MAX_DEVICES - 1)) {
          await this.state.storage.delete(`device:${id}`)
          await this.state.storage.delete(`timers:${id}`)
        }
        const subscription: PushSubscriptionJSON = { endpoint: sub!.endpoint, keys: { p256dh: sub!.keys.p256dh, auth: sub!.keys.auth } }
        await this.state.storage.put(`device:${deviceId}`, { subscription, addedAt: this.now() } satisfies Device)
        return reply({ ok: true })
      }
      case 'unsubscribe': {
        await this.state.storage.delete(`device:${deviceId}`)
        await this.state.storage.delete(`timers:${deviceId}`)
        await this.schedule()
        return reply({ ok: true })
      }
      case 'timers': {
        // The device's running timers, all of them (replacing what it sent
        // before). Its clock may differ from ours: shift by the difference
        // between when it says it sent this and when we got it.
        const sentAt = typeof body.sentAt === 'number' ? body.sentAt : this.now()
        const shift = this.now() - sentAt
        const list = Array.isArray(body.timers) ? body.timers : []
        const timers: TimerAlert[] = []
        for (const t of list.slice(0, MAX_TIMERS) as Array<Record<string, unknown>>) {
          const at = typeof t.at === 'number' ? t.at + shift : NaN
          // Only ones still to ring (within two days — a typo'd timer isn't a reminder service).
          if (!(at > this.now() && at < this.now() + 2 * 86_400_000)) continue
          const id = text(t.id, 120)
          const title = text(t.title, 120)
          if (!id || !title) continue
          timers.push({ id, at, title, body: text(t.body, 200), line: text(t.line, 200) || title, path: text(t.path, 200) || undefined })
        }
        if (timers.length && !(await this.state.storage.get(`device:${deviceId}`))) {
          return reply({ error: 'Turn notifications on first.' }, 409)
        }
        if (timers.length) await this.state.storage.put(`timers:${deviceId}`, timers)
        else await this.state.storage.delete(`timers:${deviceId}`)
        await this.schedule()
        return reply({ ok: true, timers: timers.length })
      }
      case 'test': {
        const device = await this.state.storage.get<Device>(`device:${deviceId}`)
        if (!device) return reply({ error: 'Notifications aren’t on for this device.' }, 404)
        const result = await this.push(deviceId, device, {
          title: 'Notifications are on',
          body: 'You’ll hear from us when a recipe is ready for review or a timer is done.',
          tag: 'test',
          path: 'settings',
          kind: 'test',
        })
        return reply({ result })
      }
    }
    return reply({ error: 'Unknown action.' }, 400)
  }

  /** Ring whatever timers are due, then wake for the next. */
  async alarm(): Promise<void> {
    const now = this.now()
    const devices = await this.devices()
    for (const [key, timers] of await this.state.storage.list<TimerAlert[]>({ prefix: 'timers:' })) {
      const deviceId = key.slice(7)
      const due = timers.filter((t) => t.at + RING_GRACE_MS <= now + 250).sort((a, b) => a.at - b.at)
      if (!due.length) continue
      const left = timers.filter((t) => !due.includes(t))
      // Take them off first: a push that fails isn't retried into a late alarm.
      if (left.length) await this.state.storage.put(key, left)
      else await this.state.storage.delete(key)
      const device = devices.get(deviceId)
      if (!device) continue
      const summary = left.length
        ? {
            title: left.length === 1 ? '1 timer running' : `${left.length} timers running`,
            body: left
              .sort((a, b) => a.at - b.at)
              .map((t) => t.line)
              .join('\n'),
          }
        : null
      for (const t of due) {
        // Timers go out urgently (a phone in low-power mode still gets them)
        // and aren't worth delivering ten minutes late.
        const result = await this.push(deviceId, device, { title: t.title, body: t.body, tag: `timer-${t.id}`, path: t.path, kind: 'timer', summary }, 'high', 600)
        console.log(`notify: timer "${t.title}" → ${result}, ${Math.round((this.now() - t.at) / 100) / 10}s after it rang`)
        if (result === 'gone') break
      }
    }
    await this.schedule()
  }
}
