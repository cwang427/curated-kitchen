/**
 * Tests for Web Push (worker/src/push.ts): the encryption against the worked
 * example in the standard itself (RFC 8291, Appendix A) byte for byte, a
 * round trip decrypted the way a phone does, and the VAPID signature checked
 * the way a push service does. Then the notifier (worker/src/notify.ts):
 * devices, timers ringing on its alarm, and what it refuses.
 *
 *   npm run test:push
 */
import { encryptPayload, fromB64url, b64url, makeVapidKeys, vapidHeader, sendPush, type PushMessage } from '../worker/src/push'
import { NotifyCore } from '../worker/src/notify'
import type { QueueStorage } from '../worker/src/queue'

let passed = 0
let failed = 0
function check(label: string, cond: boolean, detail?: unknown): void {
  if (cond) {
    console.log(`  ✓ ${label}`)
    passed++
  } else {
    console.error(`  ✗ ${label}${detail === undefined ? '' : `: ${JSON.stringify(detail).slice(0, 400)}`}`)
    failed++
  }
}
const enc = new TextEncoder()
const dec = new TextDecoder()

/** A P-256 key as a JWK, from the raw private scalar and the uncompressed public point. */
function jwkFrom(d: string, pub: string): JsonWebKey {
  const p = fromB64url(pub)
  return { kty: 'EC', crv: 'P-256', d, x: b64url(p.slice(1, 33)), y: b64url(p.slice(33, 65)), ext: true }
}
async function hkdf(salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, len: number) {
  const k = await crypto.subtle.importKey('raw', ikm as BufferSource, 'HKDF', false, ['deriveBits'])
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: salt as BufferSource, info: info as BufferSource }, k, len * 8))
}
/** Decrypt as the phone does (RFC 8291 §3.4, the receiving side). */
async function decrypt(body: Uint8Array, uaPrivate: JsonWebKey, uaPublic: Uint8Array, auth: Uint8Array): Promise<string> {
  const salt = body.slice(0, 16)
  const idlen = body[20]
  const asPublic = body.slice(21, 21 + idlen)
  const sealed = body.slice(21 + idlen)
  const priv = await crypto.subtle.importKey('jwk', uaPrivate, { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits'])
  const pub = await crypto.subtle.importKey('raw', asPublic as BufferSource, { name: 'ECDH', namedCurve: 'P-256' }, false, [])
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: pub } as EcdhKeyDeriveParams, priv, 256))
  const info = new Uint8Array([...enc.encode('WebPush: info\0'), ...uaPublic, ...asPublic])
  const ikm = await hkdf(auth, shared, info, 32)
  const cek = await hkdf(salt, ikm, enc.encode('Content-Encoding: aes128gcm\0'), 16)
  const nonce = await hkdf(salt, ikm, enc.encode('Content-Encoding: nonce\0'), 12)
  const key = await crypto.subtle.importKey('raw', cek as BufferSource, 'AES-GCM', false, ['decrypt'])
  const plain = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce as BufferSource }, key, sealed as BufferSource))
  let end = plain.length - 1
  while (end >= 0 && plain[end] === 0) end-- // padding
  if (plain[end] !== 2) throw new Error('no last-record marker')
  return dec.decode(plain.slice(0, end))
}

console.log('the standard’s worked example (RFC 8291, Appendix A)')
{
  const V = {
    plaintext: 'When I grow up, I want to be a watermelon',
    asPrivate: 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw',
    asPublic: 'BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8',
    uaPrivate: 'q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94',
    uaPublic: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
    auth: 'BTBZMqHH6r4Tts7J_aSIgg',
    salt: 'DGv6ra1nlYgDCS1FRnbzlw',
    body:
      'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN',
  }
  const got = await encryptPayload(
    { endpoint: 'https://push.example/x', keys: { p256dh: V.uaPublic, auth: V.auth } },
    enc.encode(V.plaintext),
    { salt: fromB64url(V.salt), privateJwk: jwkFrom(V.asPrivate, V.asPublic) },
  )
  check('our encryption matches the standard’s example byte for byte', b64url(got) === V.body, b64url(got))
  const back = await decrypt(fromB64url(V.body), jwkFrom(V.uaPrivate, V.uaPublic), fromB64url(V.uaPublic), fromB64url(V.auth))
  check('…and the test’s phone-side decryption reads the example back', back === V.plaintext, back)
}

console.log('a round trip, as a phone receives it')
{
  const phone = (await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits'])) as CryptoKeyPair
  const phonePublic = new Uint8Array((await crypto.subtle.exportKey('raw', phone.publicKey)) as ArrayBuffer)
  const phonePrivate = (await crypto.subtle.exportKey('jwk', phone.privateKey)) as JsonWebKey
  const auth = crypto.getRandomValues(new Uint8Array(16))
  const sub = { endpoint: 'https://web.push.apple.com/QGuQyavXutnMH', keys: { p256dh: b64url(phonePublic), auth: b64url(auth) } }
  const message = JSON.stringify({ title: 'Ready for review', body: 'The Best Corn Chowder — tap to take a look', tag: 'review', path: 'add' })
  const body = await encryptPayload(sub, enc.encode(message))
  check('the phone decrypts the notification', (await decrypt(body, phonePrivate, phonePublic, auth)) === message)
  const again = await encryptPayload(sub, enc.encode(message))
  check('each message is encrypted afresh (new salt and key)', b64url(again) !== b64url(body))

  const keys = await makeVapidKeys()
  const header = await vapidHeader(sub.endpoint, keys, 'https://cwang427.github.io/curated-kitchen/')
  const [, token, k] = header.match(/^vapid t=([^,]+), k=(.+)$/) ?? []
  const [h, c, sig] = token.split('.')
  const claims = JSON.parse(new TextDecoder().decode(fromB64url(c)))
  const verifyKey = await crypto.subtle.importKey('raw', fromB64url(k) as BufferSource, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify'])
  const valid = await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, verifyKey, fromB64url(sig) as BufferSource, enc.encode(`${h}.${c}`))
  check('VAPID: the signature verifies with the public key sent alongside', valid)
  check('…for that push service (aud = its origin), with a contact (sub)', claims.aud === 'https://web.push.apple.com' && claims.sub.startsWith('https://'))
  check('…expiring within a day, as Apple requires', claims.exp > Date.now() / 1000 && claims.exp <= Date.now() / 1000 + 24 * 3600)
  check('the public key is the 65-byte form the app subscribes with', fromB64url(keys.publicKey).length === 65 && fromB64url(keys.publicKey)[0] === 4)

  // Sending: the request a push service receives, and "gone" when it says so.
  const sent: Array<{ url: string; headers: Headers; body: Uint8Array }> = []
  let answer = 201
  globalThis.fetch = (async (url: RequestInfo | URL, init: RequestInit = {}) => {
    sent.push({ url: String(url), headers: new Headers(init.headers), body: new Uint8Array(init.body as ArrayBuffer) })
    return new Response(null, { status: answer })
  }) as typeof fetch
  const r1 = await sendPush(sub, { title: 'Boil pasta is done', body: 'Cacio e pepe · step 3' }, keys, { subject: 'https://x.example/', ttl: 600, urgency: 'high' })
  const req = sent[0]
  check('sent to the subscription’s endpoint, encrypted, with TTL and urgency', r1 === 'sent' && req.url === sub.endpoint && req.headers.get('Content-Encoding') === 'aes128gcm' && req.headers.get('TTL') === '600' && req.headers.get('Urgency') === 'high')
  check('…and the phone can read it', JSON.parse(await decrypt(req.body, phonePrivate, phonePublic, auth)).title === 'Boil pasta is done')
  answer = 410
  check('a subscription the service says is gone (410) → "gone"', (await sendPush(sub, { title: 'x', body: 'y' }, keys, { subject: 'https://x.example/' })) === 'gone')
}

console.log('the notifier: devices and timers')
{
  const data = new Map<string, unknown>()
  const storage: QueueStorage & { alarm: number | null } = {
    alarm: null,
    async get<T>(k: string) { return structuredClone(data.get(k)) as T | undefined },
    async put(k: string, v: unknown) { data.set(k, structuredClone(v)) },
    async delete(k: string) { return data.delete(k) },
    async list<T>({ prefix }: { prefix: string }) { return new Map([...data].filter(([k]) => k.startsWith(prefix)).map(([k, v]) => [k, structuredClone(v) as T])) },
    async setAlarm(t: number) { storage.alarm = t },
    async getAlarm() { return storage.alarm },
    async deleteAlarm() { storage.alarm = null },
  }
  let clock = Date.UTC(2026, 8, 28, 23, 0)
  const pushes: Array<{ endpoint: string; message: PushMessage; urgency?: string }> = []
  let gone = new Set<string>()
  const n = new NotifyCore({ storage }, {} as never, async (sub, message, _keys, opts) => {
    pushes.push({ endpoint: sub.endpoint, message, urgency: opts.urgency })
    return gone.has(sub.endpoint) ? 'gone' : 'sent'
  }, () => clock)
  const call = async (action: string, body: Record<string, unknown> = {}, internal = false) => {
    const res = await n.fetch(new Request(`https://notify/${action}`, { method: 'POST', headers: internal ? { 'X-Internal': '1' } : {}, body: JSON.stringify(body) }))
    return { status: res.status, body: (await res.json()) as Record<string, unknown> }
  }
  const tick = async () => {
    if (storage.alarm === null) return false
    clock = Math.max(clock, storage.alarm)
    storage.alarm = null
    await n.alarm()
    return true
  }
  const sub = (host: string) => ({ endpoint: `https://${host}/abc`, keys: { p256dh: 'BPk', auth: 'xyz' } })

  const key1 = (await call('key')).body.publicKey
  check('a VAPID key is made on first ask, and kept', typeof key1 === 'string' && (await call('key')).body.publicKey === key1)
  check('a phone subscribes (Apple’s push service)', (await call('subscribe', { deviceId: 'phone-aaaa', subscription: sub('web.push.apple.com') })).status === 200)
  check('an address that isn’t a push service is refused', (await call('subscribe', { deviceId: 'phone-bbbb', subscription: sub('evil.example') })).status === 400)
  check('…and so is a missing device id', (await call('subscribe', { subscription: sub('fcm.googleapis.com') })).status === 400)

  // Timers: the phone's clock runs 3 s fast; the notifier corrects for it.
  const phoneNow = clock + 3_000
  const put = await call('timers', {
    deviceId: 'phone-aaaa',
    sentAt: phoneNow,
    timers: [
      { id: 't1', at: phoneNow + 5 * 60_000, title: 'Simmer — time’s up', body: 'Corn chowder · step 3', line: 'Simmer · Corn chowder — rings 11:05', path: 'r/corn/cook' },
      { id: 't2', at: phoneNow + 20 * 60_000, title: 'Rest — time’s up', body: 'Steak · step 5', line: 'Rest · Steak — rings 11:20' },
      { id: 'old', at: phoneNow - 60_000, title: 'Already rang', body: '' },
    ],
  })
  check('timers stored (one already past is dropped)', put.body.timers === 2, put.body)
  check('an alarm is set for the first, a couple of seconds after it rings (phone clock corrected)', storage.alarm === clock + 5 * 60_000 + 2_000, storage.alarm! - clock)
  await tick()
  check('it rings: one urgent push, titled for the timer, opening its cook page', pushes.length === 1 && pushes[0].message.title === 'Simmer — time’s up' && pushes[0].urgency === 'high' && pushes[0].message.path === 'r/corn/cook', pushes)
  check('…carrying what’s still running, for the “timers running” note', pushes[0].message.summary?.title === '1 timer running' && /Steak/.test(pushes[0].message.summary.body))
  check('…and the alarm moves to the next timer', storage.alarm === clock + 15 * 60_000, storage.alarm! - clock)
  // The app rang the second one itself (it was open): it sends an empty list.
  await call('timers', { deviceId: 'phone-aaaa', sentAt: clock, timers: [] })
  check('a timer the app already rang is taken off — no alarm, no push', storage.alarm === null && !(await tick()) && pushes.length === 1)
  check('timers need notifications on for that device', (await call('timers', { deviceId: 'tablet-cccc', timers: [{ id: 'x', at: clock + 60_000, title: 't' }] })).status === 409)

  // "Ready for review", from the queue (inside the Worker only).
  await call('subscribe', { deviceId: 'ipad-dddd', subscription: sub('fcm.googleapis.com') })
  check('`send` from outside is refused', (await call('send', { title: 'hi' })).status === 404)
  const sent = await call('send', { title: 'Ready for review', body: 'Corn chowder', tag: 'import-1', path: 'add' }, true)
  check('`send` from the queue reaches every device', sent.body.sent === 2 && pushes.slice(-2).every((p) => p.message.title === 'Ready for review' && p.message.kind === 'review'))
  gone = new Set(['https://fcm.googleapis.com/abc'])
  await call('send', { title: 'Again', body: '' }, true)
  check('a device the push service says is gone is forgotten', !data.has('device:ipad-dddd') && data.has('device:phone-aaaa'))
  check('test → a notification to that device', (await call('test', { deviceId: 'phone-aaaa' })).body.result === 'sent' && pushes.at(-1)!.message.title === 'Notifications are on')
  await call('unsubscribe', { deviceId: 'phone-aaaa' })
  check('unsubscribe → forgotten', !data.has('device:phone-aaaa'))
}

console.log(`\n${passed} passed, ${failed} failed`)
if (failed) (globalThis as { process?: { exit(code: number): never } }).process?.exit(1)
