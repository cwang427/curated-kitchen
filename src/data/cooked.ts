import { useEffect, useState } from 'react'
import { deleteField, doc, onSnapshot, setDoc, type DocumentData } from 'firebase/firestore'
import { db } from '../lib/firebase'
import { parseCooked, type CookedEntry, type CookedMap, type OtherCook } from '../lib/ratings'

/*
 * "I've made this" + a 1–10 score, per person, kept on their own profile doc
 * as `cooked.<slug> = { madeAt, rating }` (see src/lib/ratings.ts). The rules
 * already let anyone write their own profile and any signed-in user read one,
 * so guests can rate the recipes they visit — no firestore.rules change.
 *
 * Every write is a merge into the one recipe's entry, so it never touches the
 * profile's other fields (name, kitchens, a staged invite) or other recipes.
 */

const profileDoc = (uid: string) => doc(db, 'users', uid)

// Your own records — one live listener for the whole app (the kitchen's
// checkmarks, the recipe page and cook mode all read it), so going back to
// the kitchen never shows the tiles without their ✓ first.
type MySnapshot = { uid: string | null; cooked: CookedMap }
let mine: MySnapshot = { uid: null, cooked: {} }
const listeners = new Set<() => void>()
function publish(next: MySnapshot): void {
  mine = next
  for (const listener of listeners) listener()
}

/** Keep the signed-in person's records live. Returns the unsubscribe. */
export function watchMyCooked(uid: string | null): () => void {
  if (!uid) {
    publish({ uid: null, cooked: {} })
    return () => {}
  }
  if (mine.uid !== uid) publish({ uid, cooked: {} })
  return onSnapshot(
    profileDoc(uid),
    (snapshot) => publish({ uid, cooked: parseCooked(snapshot.data()?.cooked) }),
    // Keep what we had: a dropped listener mustn't wipe the checkmarks.
    () => {},
  )
}

/** The signed-in person's records, by recipe slug. */
export function useMyCooked(): CookedMap {
  const [cooked, setCooked] = useState(mine.cooked)
  useEffect(() => {
    const listener = () => setCooked(mine.cooked)
    listeners.add(listener)
    setCooked(mine.cooked)
    return () => void listeners.delete(listener)
  }, [])
  return cooked
}

function nameOf(data: DocumentData | undefined): string {
  if (typeof data?.displayName === 'string' && data.displayName.trim()) return data.displayName.trim()
  if (typeof data?.email === 'string' && data.email.includes('@')) return data.email.split('@')[0]
  return 'Someone'
}

/**
 * Everyone else in the kitchen who has made this recipe, live (a partner
 * rating it on their phone shows up here at once). A kitchen is a handful of
 * people, so one small listener each is fine.
 */
export function useOthersCooked(uids: string[], slug: string | null): OtherCook[] {
  const key = uids.join(',')
  const [byUid, setByUid] = useState<Record<string, OtherCook | null>>({})

  useEffect(() => {
    setByUid({})
    if (!slug || !key) return
    const unsubscribes = key.split(',').map((uid) =>
      onSnapshot(
        profileDoc(uid),
        (snapshot) => {
          const data = snapshot.data()
          const entry = parseCooked(data?.cooked)[slug]
          setByUid((prev) => ({ ...prev, [uid]: entry ? { uid, name: nameOf(data), entry } : null }))
        },
        // Someone we can't read just doesn't show.
        () => {},
      ),
    )
    return () => unsubscribes.forEach((unsubscribe) => unsubscribe())
  }, [key, slug])

  return Object.values(byUid).filter((o): o is OtherCook => o !== null)
}

/** Mark a recipe as made today (keeps an existing score). */
export async function markMade(uid: string, slug: string): Promise<void> {
  await setDoc(profileDoc(uid), { cooked: { [slug]: { madeAt: Date.now() } } }, { merge: true })
}

/**
 * Set (or with null, clear) your score. Scoring something you hadn't marked
 * yet marks it made too — you only score what you've cooked.
 */
export async function setMyRating(
  uid: string,
  slug: string,
  rating: number | null,
  current: CookedEntry | null,
): Promise<void> {
  await setDoc(
    profileDoc(uid),
    { cooked: { [slug]: { rating, ...(current ? {} : { madeAt: Date.now() }) } } },
    { merge: true },
  )
}

/** "I haven't made it after all" — drops the ✓ and the score. */
export async function unmarkMade(uid: string, slug: string): Promise<void> {
  await setDoc(profileDoc(uid), { cooked: { [slug]: deleteField() } }, { merge: true })
}

/**
 * A copy is a new recipe (a new slug), but you've still made it: the person
 * copying keeps their ✓ and score on the copy. (Only their own — nobody can
 * write someone else's profile.)
 */
export async function carryCooked(uid: string, slug: string, entry: CookedEntry): Promise<void> {
  await setDoc(profileDoc(uid), { cooked: { [slug]: entry } }, { merge: true })
}

// Cook mode's Finish ✓ goes back up to the recipe page and asks it to open
// "How was it?" there — the page where your score lives. (Cook mode itself
// leaves at once, as before: staying open after ending a shared cook would
// put the dish back on this phone's cook board.)
let ratePrompt: { slug: string; at: number } | null = null

export function askToRate(slug: string): void {
  ratePrompt = { slug, at: Date.now() }
}

/** True once, when cook mode just asked this recipe's page to open the sheet. */
export function takeRatePrompt(slug: string): boolean {
  const ask = ratePrompt
  if (!ask || ask.slug !== slug) return false
  ratePrompt = null
  // A stale ask (the page never came up) mustn't pop up on some later visit.
  return Date.now() - ask.at < 15_000
}
