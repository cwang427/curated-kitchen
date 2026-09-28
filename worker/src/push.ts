/**
 * Web Push, sent from the Worker — notifications to the installed app, even
 * when it's closed ("The Best Corn Chowder is ready for review", "Boil pasta
 * is done"). Standard Web Push, the way every browser's push service expects:
 *
 *  - VAPID (RFC 8292): each request carries a short-lived token signed with
 *    our key, so the push service knows the message is from the server the
 *    phone subscribed to. The key pair is made the first time it's needed and
 *    kept in the person's queue (a Durable Object) — nothing to set up.
 *  - Encryption (RFC 8291, "aes128gcm"): the message is encrypted for that one
 *    phone's key, so the push service (Apple's, Google's, Mozilla's) can't
 *    read it.
 *
 * All with the Workers runtime's own WebCrypto — no packages.
 */

export interface PushSubscriptionJSON {
  endpoint: string
  keys: { p256dh: string; auth: string }
}

/** Our VAPID key pair, as JWKs (the private one never leaves the Worker). */
export interface VapidKeys {
  publicJwk: JsonWebKey
  privateJwk: JsonWebKey
  /** The public key as the app needs it (65-byte uncompressed point, base64url). */
  publicKey: string
}

const enc = new TextEncoder()

export function b64url(bytes: Uint8Array): string {
  let s = ''
  for (const b of bytes) s += String.fromCharCode(b)
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
export function fromB64url(s: string): Uint8Array {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4)
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}
function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let at = 0
  for (const p of parts) {
    out.set(p, at)
    at += p.length
  }
  return out
}

/** A new VAPID key pair (ECDSA P-256). */
export async function makeVapidKeys(): Promise<VapidKeys> {
  const pair = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])) as CryptoKeyPair
  const publicJwk = (await crypto.subtle.exportKey('jwk', pair.publicKey)) as JsonWebKey
  const privateJwk = (await crypto.subtle.exportKey('jwk', pair.privateKey)) as JsonWebKey
  const raw = new Uint8Array((await crypto.subtle.exportKey('raw', pair.publicKey)) as ArrayBuffer)
  return { publicJwk, privateJwk, publicKey: b64url(raw) }
}

/** The VAPID Authorization header for one push service (its origin is the
 * token's audience), valid for 12 hours. */
export async function vapidHeader(endpoint: string, keys: VapidKeys, subject: string): Promise<string> {
  const aud = new URL(endpoint).origin
  const header = b64url(enc.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })))
  const claims = b64url(enc.encode(JSON.stringify({ aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: subject })))
  const key = await crypto.subtle.importKey('jwk', keys.privateJwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign'])
  // WebCrypto's ECDSA signature is already r‖s, the form JWT's ES256 wants.
  const sig = new Uint8Array(
    await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, enc.encode(`${header}.${claims}`)),
  )
  return `vapid t=${header}.${claims}.${b64url(sig)}, k=${keys.publicKey}`
}

async function hkdf(salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, length: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', ikm as BufferSource, 'HKDF', false, ['deriveBits'])
  return new Uint8Array(
    await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: salt as BufferSource, info: info as BufferSource }, key, length * 8),
  )
}

/** Encrypt a message for one subscription (RFC 8291 / RFC 8188, aes128gcm):
 * a single record, the sender's one-time public key in its header. */
export async function encryptPayload(
  sub: PushSubscriptionJSON,
  payload: Uint8Array,
  // Only for the test against the standard's worked example (RFC 8291 A):
  // a fixed salt and sender key instead of fresh random ones.
  fixed?: { salt: Uint8Array; privateJwk: JsonWebKey },
): Promise<Uint8Array> {
  const uaPublic = fromB64url(sub.keys.p256dh)
  const authSecret = fromB64url(sub.keys.auth)
  const local: CryptoKeyPair = fixed
    ? {
        privateKey: await crypto.subtle.importKey('jwk', fixed.privateJwk, { name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']),
        publicKey: await crypto.subtle.importKey('jwk', { ...fixed.privateJwk, d: undefined, key_ops: undefined }, { name: 'ECDH', namedCurve: 'P-256' }, true, []),
      }
    : ((await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits'])) as CryptoKeyPair)
  const asPublic = new Uint8Array((await crypto.subtle.exportKey('raw', local.publicKey)) as ArrayBuffer)
  const uaKey = await crypto.subtle.importKey('raw', uaPublic as BufferSource, { name: 'ECDH', namedCurve: 'P-256' }, false, [])
  const shared = new Uint8Array(
    await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey } as EcdhKeyDeriveParams, local.privateKey, 256),
  )
  // The input keying material, bound to both public keys and the phone's secret.
  const ikm = await hkdf(authSecret, shared, concat(enc.encode('WebPush: info\0'), uaPublic, asPublic), 32)
  const salt = fixed?.salt ?? crypto.getRandomValues(new Uint8Array(16))
  const cek = await hkdf(salt, ikm, enc.encode('Content-Encoding: aes128gcm\0'), 16)
  const nonce = await hkdf(salt, ikm, enc.encode('Content-Encoding: nonce\0'), 12)
  const key = await crypto.subtle.importKey('raw', cek as BufferSource, 'AES-GCM', false, ['encrypt'])
  // The one and last record: the message, then the 0x02 "last record" marker.
  const sealed = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce as BufferSource }, key, concat(payload, new Uint8Array([2])) as BufferSource),
  )
  const rs = new Uint8Array(4)
  new DataView(rs.buffer).setUint32(0, 4096)
  return concat(salt, rs, new Uint8Array([asPublic.length]), asPublic, sealed)
}

/** What a notification says, and where tapping it goes. */
export interface PushMessage {
  title: string
  body: string
  /** Same tag = replaces the earlier notification instead of stacking. */
  tag?: string
  /** The app page to open, relative to the app (e.g. "add", "r/corn-chowder"). */
  path?: string
  /** What it's about, so the app's service worker can treat timers specially. */
  kind?: 'review' | 'timer' | 'test'
  /** With a timer: the "timers running" note to show in place of the old one
   * (what's still counting down), or null when nothing is. */
  summary?: { title: string; body: string } | null
}

/**
 * Send one notification. Returns "gone" when the push service says the
 * subscription no longer exists (the app was removed, or notifications turned
 * off) — the caller forgets it.
 */
export async function sendPush(
  sub: PushSubscriptionJSON,
  message: PushMessage,
  keys: VapidKeys,
  { subject, ttl = 3600, urgency = 'normal' }: { subject: string; ttl?: number; urgency?: 'normal' | 'high' },
): Promise<'sent' | 'gone' | 'failed'> {
  try {
    const body = await encryptPayload(sub, enc.encode(JSON.stringify(message)))
    const res = await fetch(sub.endpoint, {
      method: 'POST',
      headers: {
        Authorization: await vapidHeader(sub.endpoint, keys, subject),
        'Content-Encoding': 'aes128gcm',
        'Content-Type': 'application/octet-stream',
        TTL: String(ttl),
        Urgency: urgency,
      },
      body: body as BufferSource,
    })
    await res.body?.cancel()
    if (res.status === 404 || res.status === 410) return 'gone'
    if (!res.ok) console.log(`push: ${new URL(sub.endpoint).host} answered ${res.status}`)
    return res.ok ? 'sent' : 'failed'
  } catch (e) {
    console.log(`push: failed ${String(e)}`)
    return 'failed'
  }
}
