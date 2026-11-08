/**
 * Feedback from friends to the app's owner (v0.55) — pure helpers, no
 * React/Firebase, so the scripts can test them under Node.
 *
 * A friend writes a few lines in Settings; it's stored privately (the
 * `feedback` collection, readable only by the owner of the app's main kitchen
 * — see firestore.rules) with what they were running, so "the star thing is
 * broken" comes with the version and phone it happened on.
 */

/** Long enough for a real message, short enough to fit on a phone screen. */
export const FEEDBACK_MAX = 2000

export interface FeedbackItem {
  id: string
  /** Who sent it (uid), and their name as it was then. */
  uid: string
  name: string
  text: string
  /** The app build they were on: "0.55.0 (9c6261e)". */
  version: string
  /** Their phone, in words: "iPhone · iOS 18.2 · Home Screen app". */
  device: string
  createdAt: number | null
  /** Handled — the owner ticked it off. */
  done: boolean
}

/**
 * The sender's phone in a few words, from the browser's user agent. Only
 * what helps reproduce a problem: the kind of device, its OS version, and
 * whether it's the installed Home Screen app (which behaves differently on
 * iPhone) or a browser tab.
 */
export function deviceLabel(userAgent: string, installed: boolean, touchPoints = 0): string {
  const ua = userAgent
  const parts: string[] = []
  const ios = ua.match(/\b(iPhone|iPad|iPod)\b.*?OS (\d+)[_.](\d+)/)
  // iPadOS asks for the desktop site and calls itself a Mac; a touchscreen
  // (navigator.maxTouchPoints) gives it away — no Mac has one.
  const iPadAsMac = /Macintosh/.test(ua) && touchPoints > 1
  const android = ua.match(/Android (\d+(?:\.\d+)?)/)
  if (ios) parts.push(ios[1], `iOS ${ios[2]}.${ios[3]}`)
  else if (iPadAsMac) parts.push('iPad')
  else if (android) parts.push(`Android ${android[1]}`)
  else if (/Macintosh/.test(ua)) parts.push('Mac')
  else if (/Windows/.test(ua)) parts.push('Windows')
  else if (/Linux/.test(ua)) parts.push('Linux')
  else parts.push('Unknown device')
  parts.push(installed ? 'Home Screen app' : 'browser')
  return parts.join(' · ')
}

/**
 * The open items as one block of text, for the owner to paste into a chat
 * with Claude ("here's what friends said — fix what you can"). Oldest first,
 * so it reads in the order things happened; each with who, when, and what
 * they were running.
 */
export function feedbackForClaude(items: FeedbackItem[]): string {
  // One still sending has no server time yet: it's the newest, so it goes last.
  const at = (f: FeedbackItem) => f.createdAt ?? Number.MAX_SAFE_INTEGER
  const open = items.filter((f) => !f.done).sort((a, b) => at(a) - at(b))
  if (open.length === 0) return ''
  const when = (at: number | null) =>
    at ? new Date(at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : 'date unknown'
  const blocks = open.map((f, i) => {
    const body = f.text.trim().split('\n').map((line) => `   ${line}`).join('\n')
    return `${i + 1}. ${f.name} — ${when(f.createdAt)} · ${f.device} · v${f.version}\n${body}`
  })
  return `Feedback from friends using Curated Kitchen (${open.length} open):\n\n${blocks.join('\n\n')}\n`
}
