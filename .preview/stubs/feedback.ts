import { useState } from 'react'
import type { FeedbackItem } from '../../src/lib/feedback'

// Feedback against fixtures. Default: a friend's "Send feedback" box (owner
// Cassidy). ?feedbackowner: the owner's inbox. ?sendfail: sending fails.
// ?sendslow: no signal (the "saved on your phone" path).
const params = typeof location !== 'undefined' ? new URLSearchParams(location.search) : new URLSearchParams()
export const FEEDBACK_KITCHEN = 'hh_preview'

const HOUR = 3_600_000
let items: FeedbackItem[] = [
  { id: 'f1', uid: 'friend_uid', name: 'Sam', text: 'The star on the tiles confused me at first — is that my rating or everyone’s?', version: '0.55.0 (9c6261e)', device: 'iPhone · iOS 18.2 · Home Screen app', createdAt: Date.now() - 2 * HOUR, done: false },
  { id: 'f2', uid: 'partner_uid', name: 'Jordan', text: 'Could the grocery list sort by store?\nWe go to two different ones.', version: '0.54.0 (9c6261e)', device: 'iPhone · iOS 18.1 · browser', createdAt: Date.now() - 26 * HOUR, done: false },
  { id: 'f3', uid: 'friend_uid', name: 'Sam', text: 'Timer didn’t ring with the screen locked', version: '0.53.2 (af7fe62)', device: 'iPhone · iOS 18.2 · Home Screen app', createdAt: Date.now() - 300 * HOUR, done: true },
]
const listeners = new Set<() => void>()

export function watchFeedback(): () => void {
  return () => {}
}

export function useFeedback() {
  const [, force] = useState(0)
  useState(() => {
    const listener = () => force((n) => n + 1)
    listeners.add(listener)
    return listener
  })
  return params.has('feedbackowner')
    ? { owner: true, ownerName: null, items }
    : { owner: false, ownerName: 'Cassidy', items: [] }
}

export function sendFeedback(): Promise<void> {
  if (params.has('sendslow')) return new Promise(() => {})
  return new Promise((resolve, reject) =>
    setTimeout(() => (params.has('sendfail') ? reject(new Error('permission-denied')) : resolve()), 400),
  )
}

export async function setFeedbackDone(id: string, done: boolean): Promise<void> {
  items = items.map((f) => (f.id === id ? { ...f, done } : f))
  for (const listener of listeners) listener()
}
