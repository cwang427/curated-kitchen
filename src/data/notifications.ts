import { useEffect, useState } from 'react'
import { callWorker } from './importQueue'
import { runningNote, type TimerAlert } from '../lib/timerAlerts'

/**
 * Notifications on this phone: "Ready for review" when an import finishes,
 * and kitchen timers that ring with the app closed. The Worker sends them
 * (worker/src/notify.ts) through the phone's own push service; the app's
 * service worker shows them (public/push-sw.js).
 *
 * On iPhone this works only in the Home Screen app (iOS 16.4+), never in a
 * Safari tab — Apple's rule — and permission can only be asked from a tap.
 */

const ON_KEY = 'ck.notify.on'
const DEVICE_KEY = 'ck.notify.device'
const NUDGED_KEY = 'ck.notify.nudged.'
const TIMERS_NOTE_KEY = 'ck.notify.timersNote'

function read(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}
function write(key: string, value: string | null): void {
  try {
    if (value === null) localStorage.removeItem(key)
    else localStorage.setItem(key, value)
  } catch {
    /* private mode — it just won't be remembered */
  }
}

export type PushSupport = 'ok' | 'needs-home-screen' | 'unsupported'

function isIos(): boolean {
  return /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
}
function isStandalone(): boolean {
  return window.matchMedia?.('(display-mode: standalone)').matches || (navigator as { standalone?: boolean }).standalone === true
}

export function pushSupport(): PushSupport {
  if ('serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window) return 'ok'
  return isIos() && !isStandalone() ? 'needs-home-screen' : 'unsupported'
}

/** This phone's id with the Worker (one per browser, kept locally). */
function deviceId(): string {
  let id = read(DEVICE_KEY)
  if (!id) {
    id = crypto.randomUUID().replace(/-/g, '')
    write(DEVICE_KEY, id)
  }
  return id
}

export interface NotifyState {
  support: PushSupport
  /** Turned on here, and still allowed. */
  on: boolean
  /** The phone's answer: blocked means only its Settings can undo it. */
  blocked: boolean
}
function current(): NotifyState {
  const support = pushSupport()
  const permission = support === 'ok' ? Notification.permission : 'default'
  return { support, on: support === 'ok' && permission === 'granted' && read(ON_KEY) === '1', blocked: permission === 'denied' }
}
const listeners = new Set<() => void>()
function changed(): void {
  for (const listener of listeners) listener()
}
export function useNotifications(): NotifyState {
  const [state, setState] = useState(current)
  useEffect(() => {
    const listener = () => setState(current())
    listeners.add(listener)
    listener()
    return () => void listeners.delete(listener)
  }, [])
  return state
}

function fromB64url(s: string): Uint8Array<ArrayBuffer> {
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4))
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}
function sameKey(a: ArrayBuffer | null | undefined, b: Uint8Array): boolean {
  if (!a) return false
  const x = new Uint8Array(a)
  return x.length === b.length && x.every((v, i) => v === b[i])
}

async function registration(): Promise<ServiceWorkerRegistration> {
  const timeout = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error('The app is still setting up — close it, open it again, and retry.')), 10_000),
  )
  return Promise.race([navigator.serviceWorker.ready, timeout])
}

const BLOCKED = isIos()
  ? 'Notifications are turned off for this app. To turn them on: iPhone Settings › Notifications › Kitchen › Allow Notifications, then try again.'
  : 'Notifications are blocked for this site — allow them in your browser’s site settings, then try again.'

/** Turn notifications on — call straight from a tap (the phone asks the cook). */
export async function enableNotifications(): Promise<void> {
  const support = pushSupport()
  if (support === 'needs-home-screen') throw new Error('On iPhone, notifications work in the Home Screen app: tap Share › Add to Home Screen, then open Kitchen from there.')
  if (support !== 'ok') throw new Error('This browser can’t show notifications.')
  // First thing, while it's still "from the tap" — iPhone won't ask otherwise.
  const permission = await Notification.requestPermission()
  changed()
  if (permission !== 'granted') throw new Error(permission === 'denied' ? BLOCKED : 'Notifications weren’t turned on.')
  const reg = await registration()
  const { status, data } = await callWorker('notify/key').catch(() => ({ status: -1, data: {} as Record<string, unknown> }))
  if (status !== 200 || typeof data.publicKey !== 'string') {
    // Anything but a key: the Worker is older than 0.50 (or has no notifier yet).
    throw new Error(status === -1 ? 'Couldn’t reach the server — try again in a moment.' : 'Notifications aren’t set up on the server yet.')
  }
  const key = fromB64url(data.publicKey)
  let sub = await reg.pushManager.getSubscription()
  if (sub && !sameKey(sub.options.applicationServerKey, key)) {
    await sub.unsubscribe()
    sub = null
  }
  sub ??= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key })
  const saved = await callWorker('notify/subscribe', { deviceId: deviceId(), subscription: sub.toJSON() })
  if (saved.status !== 200) throw new Error(typeof saved.data.error === 'string' ? saved.data.error : 'Couldn’t turn notifications on — try again.')
  write(ON_KEY, '1')
  changed()
  flushTimers()
}

export async function disableNotifications(): Promise<void> {
  write(ON_KEY, null)
  changed()
  try {
    const sub = await (await registration()).pushManager.getSubscription()
    await sub?.unsubscribe()
  } catch {
    /* already gone */
  }
  await callWorker('notify/unsubscribe', { deviceId: deviceId() }).catch(() => undefined)
}

export async function sendTestNotification(): Promise<string | null> {
  const { status, data } = await callWorker('notify/test', { deviceId: deviceId() }).catch(() => ({ status: -1, data: {} as Record<string, unknown> }))
  if (status === 200 && data.result === 'sent') return null
  if (status === 200 && data.result === 'gone') {
    write(ON_KEY, null)
    changed()
    return 'This phone’s notifications had been switched off — turn them on again.'
  }
  return typeof data.error === 'string' ? data.error : 'Couldn’t send one just now — try again in a moment.'
}

/** On opening the app: re-register this phone with the Worker (its push
 * address can change), or notice notifications were switched off in the
 * phone's settings. */
export async function refreshNotifications(): Promise<void> {
  if (read(ON_KEY) !== '1') return
  if (pushSupport() !== 'ok' || Notification.permission !== 'granted') {
    write(ON_KEY, null)
    changed()
    return
  }
  try {
    const sub = await (await registration()).pushManager.getSubscription()
    if (!sub) {
      write(ON_KEY, null)
      changed()
      return
    }
    await callWorker('notify/subscribe', { deviceId: deviceId(), subscription: sub.toJSON() })
  } catch {
    /* offline — next time */
  }
}

/** "Not now" on a suggestion to turn them on, remembered per place. */
export function nudgeDismissed(where: 'imports' | 'timers'): boolean {
  return read(NUDGED_KEY + where) === '1'
}
export function dismissNudge(where: 'imports' | 'timers'): void {
  write(NUDGED_KEY + where, '1')
  changed()
}

/** The "timers running" note when you leave the app (on unless turned off). */
export function timersNoteOn(): boolean {
  return read(TIMERS_NOTE_KEY) !== '0'
}
export function setTimersNote(on: boolean): void {
  write(TIMERS_NOTE_KEY, on ? null : '0')
  changed()
}

// ---- Timers ------------------------------------------------------------------

let latest: TimerAlert[] = []
/** Timers this phone rang itself (cook mode, open and showing): no push. */
const rangHere = new Set<string>()
let flushTimer: ReturnType<typeof setTimeout> | undefined
let lastSent = '-' // (anything but a real list: the first sync always goes out, clearing what an earlier visit left)

const pending = (now = Date.now()) => latest.filter((a) => a.at > now && !rangHere.has(`${a.id}@${a.at}`))

/** The phone's running timers, to ring with the app closed. */
export function syncTimers(alerts: TimerAlert[]): void {
  latest = alerts
  clearTimeout(flushTimer)
  flushTimer = setTimeout(flushTimers, 300)
}

/** Cook mode rang this one itself: take it off, before the push goes out. */
export function timerRangHere(id: string, at: number): void {
  rangHere.add(`${id}@${at}`)
  flushTimers()
}

function flushTimers(): void {
  clearTimeout(flushTimer)
  if (!current().on) return
  const timers = pending()
  const key = timers.map((a) => `${a.id}@${a.at}`).join('|')
  if (key === lastSent) return
  lastSent = key
  void callWorker('notify/timers', { deviceId: deviceId(), sentAt: Date.now(), timers }).catch(() => {
    lastSent = '' // offline: try again next time something changes
  })
}

/** Leaving the app with timers running: a note listing them. Coming back:
 * clear it (and any rung timers — the app shows those itself). */
export async function showRunningNote(): Promise<void> {
  if (!current().on || !timersNoteOn()) return
  const note = runningNote(pending())
  if (!note) return
  try {
    const reg = await registration()
    await reg.showNotification(note.title, { body: note.body, tag: 'timers', silent: true, data: { path: pending()[0]?.path ?? '' } })
  } catch {
    /* best effort */
  }
}
export async function clearTimerNotes(): Promise<void> {
  if (pushSupport() !== 'ok' || Notification.permission !== 'granted') return
  try {
    const reg = await registration()
    for (const n of await reg.getNotifications()) if (n.tag === 'timers' || n.tag.startsWith('timer-')) n.close()
  } catch {
    /* best effort */
  }
  flushTimers()
}
