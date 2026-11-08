import { useEffect, useState } from 'react'
import {
  collection,
  doc,
  getDoc,
  onSnapshot,
  query,
  serverTimestamp,
  setDoc,
  where,
  type DocumentData,
} from 'firebase/firestore'
import { db } from '../lib/firebase'
import { deviceLabel, type FeedbackItem } from '../lib/feedback'
import { isStandalone } from './notifications'

/*
 * Feedback from friends, kept privately for the app's owner (v0.55).
 *
 * "The app's owner" is the owner of its main kitchen — the one the weekly
 * recipe backup saves, whose id the deploy passes in from the repo's
 * KITCHEN_HOUSEHOLD_ID variable (deploy.yml → VITE_FEEDBACK_KITCHEN). Every
 * message is addressed to that kitchen, and firestore.rules lets only its
 * owner read one, so nobody has to look up or paste an account id. Anyone
 * signed in can send (friends who only have their own kitchen too); nobody
 * but the owner can read, change or delete.
 */
export const FEEDBACK_KITCHEN: string = (import.meta.env.VITE_FEEDBACK_KITCHEN ?? '').trim()

function toMillis(value: unknown): number | null {
  if (value && typeof value === 'object' && 'toMillis' in value) {
    return (value as { toMillis: () => number }).toMillis()
  }
  return typeof value === 'number' ? value : null
}

function toItem(id: string, data: DocumentData): FeedbackItem {
  return {
    id,
    uid: typeof data.uid === 'string' ? data.uid : '',
    name: typeof data.name === 'string' && data.name.trim() ? data.name.trim() : 'Someone',
    text: typeof data.text === 'string' ? data.text : '',
    version: typeof data.version === 'string' ? data.version : '?',
    device: typeof data.device === 'string' ? data.device : '',
    createdAt: toMillis(data.createdAt),
    done: data.done === true,
  }
}

/**
 * Send a message to the owner. Resolves once Firestore has it — but a phone
 * with no signal keeps the message on the phone and sends it when it can
 * (the app's offline cache), so the screen doesn't wait on that; see
 * FeedbackForm.
 */
export function sendFeedback(uid: string, name: string, text: string): Promise<void> {
  return setDoc(doc(collection(db, 'feedback')), {
    uid,
    name,
    text: text.trim(),
    householdId: FEEDBACK_KITCHEN,
    version: `${__BUILD__.version} (${__BUILD__.commit})`,
    device: deviceLabel(navigator.userAgent, isStandalone(), navigator.maxTouchPoints ?? 0),
    createdAt: serverTimestamp(),
    done: false,
  })
}

/** Tick a message off (or bring it back). Owner only, by the rules. */
export async function setFeedbackDone(id: string, done: boolean): Promise<void> {
  await setDoc(doc(db, 'feedback', id), { done }, { merge: true })
}

// Who the feedback goes to, and — for the owner — the inbox. One app-wide
// listener (the header's count and Settings both read it), like the review
// list.
export type FeedbackSnapshot = {
  /** The signed-in person is the app's owner: they get the inbox, not the form. */
  owner: boolean
  /** The owner's name, for "Sent to Cassidy" (null when it can't be read). */
  ownerName: string | null
  /** The owner's messages, newest first. Empty for everyone else. */
  items: FeedbackItem[]
}
let snapshot: FeedbackSnapshot = { owner: false, ownerName: null, items: [] }
const listeners = new Set<() => void>()
function publish(next: FeedbackSnapshot): void {
  snapshot = next
  for (const listener of listeners) listener()
}

/** Work out who the owner is and, if it's you, keep the inbox live. */
export function watchFeedback(uid: string | null): () => void {
  publish({ owner: false, ownerName: null, items: [] })
  if (!uid || !FEEDBACK_KITCHEN) return () => {}
  let stopped = false
  let unsubscribe = () => {}
  void (async () => {
    // Members and guests of the main kitchen can read it; anyone else can't,
    // and simply isn't its owner — their message still goes through.
    let ownerUid: string | null = null
    try {
      const kitchen = await getDoc(doc(db, 'households', FEEDBACK_KITCHEN))
      ownerUid = typeof kitchen.data()?.ownerUid === 'string' ? kitchen.data()!.ownerUid : null
    } catch {
      return
    }
    if (stopped || !ownerUid) return
    if (ownerUid !== uid) {
      try {
        const profile = await getDoc(doc(db, 'users', ownerUid))
        const name = profile.data()?.displayName
        if (!stopped && typeof name === 'string' && name.trim()) {
          publish({ owner: false, ownerName: name.trim(), items: [] })
        }
      } catch {
        // "Sent — thanks!" without a name is fine.
      }
      return
    }
    publish({ owner: true, ownerName: null, items: [] })
    // An equality filter on householdId is what lets the rules check this
    // query (only the owner of that kitchen may read its feedback).
    unsubscribe = onSnapshot(
      query(collection(db, 'feedback'), where('householdId', '==', FEEDBACK_KITCHEN)),
      (snap) =>
        publish({
          owner: true,
          ownerName: null,
          items: snap.docs
            .map((d) => toItem(d.id, d.data()))
            .sort((a, b) => (b.createdAt ?? Number.MAX_SAFE_INTEGER) - (a.createdAt ?? Number.MAX_SAFE_INTEGER)),
        }),
      // Keep what we had: a dropped listener mustn't empty the inbox.
      () => {},
    )
  })()
  return () => {
    stopped = true
    unsubscribe()
  }
}

/** The owner's inbox (or, for everyone else, who their feedback goes to). */
export function useFeedback(): FeedbackSnapshot {
  const [state, setState] = useState(snapshot)
  useEffect(() => {
    const listener = () => setState(snapshot)
    listeners.add(listener)
    setState(snapshot)
    return () => void listeners.delete(listener)
  }, [])
  return state
}
