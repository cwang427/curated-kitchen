/**
 * Security-rules test. Runs under `firebase emulators:exec`, which starts the
 * Auth and Firestore emulators first. Every operation goes through the real
 * rules — there is no admin bypass here — so seeding legitimate data doubles
 * as an allow/deny assertion.
 *
 *   npm run test:rules
 */
import { initializeApp, deleteApp, type FirebaseApp } from 'firebase/app'
import {
  connectAuthEmulator,
  createUserWithEmailAndPassword,
  getAuth,
  signOut,
  type Auth,
} from 'firebase/auth'
import {
  arrayRemove,
  arrayUnion,
  collection,
  connectFirestoreEmulator,
  deleteDoc,
  deleteField,
  doc,
  getDoc,
  getDocs,
  getFirestore,
  query,
  serverTimestamp,
  setDoc,
  updateDoc,
  where,
  type Firestore,
} from 'firebase/firestore'

const PROJECT = 'curated-kitchen-rules-test'
let passed = 0
let failed = 0

async function expectAllow(label: string, op: () => Promise<unknown>): Promise<void> {
  try {
    await op()
    console.log(`  ✓ ${label}`)
    passed++
  } catch (error) {
    console.error(`  ✗ ${label} — expected ALLOW, got: ${(error as Error).message}`)
    failed++
  }
}

async function expectDeny(label: string, op: () => Promise<unknown>): Promise<void> {
  try {
    await op()
    console.error(`  ✗ ${label} — expected DENY, but it was allowed`)
    failed++
  } catch (error) {
    const code = (error as { code?: string }).code ?? ''
    if (code.includes('permission-denied')) {
      console.log(`  ✓ ${label}`)
      passed++
    } else {
      console.error(`  ✗ ${label} — denied, but for the wrong reason: ${(error as Error).message}`)
      failed++
    }
  }
}

/** A fresh app + signed-in user, so each identity is fully isolated. */
async function asUser(email: string): Promise<{ db: Firestore; uid: string; app: FirebaseApp; auth: Auth }> {
  const app = initializeApp({ apiKey: 'fake', projectId: PROJECT }, `app-${email}-${Math.random()}`)
  const auth = getAuth(app)
  connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true })
  const db = getFirestore(app)
  connectFirestoreEmulator(db, '127.0.0.1', 8080)
  const cred = await createUserWithEmailAndPassword(auth, email, 'password123')
  return { db, uid: cred.user.uid, app, auth }
}

async function main(): Promise<void> {
  const A = await asUser('a@kitchen.local')
  const B = await asUser('b@kitchen.local')
  const C = await asUser('c@kitchen.local')

  const hhA = `hh_${A.uid.slice(0, 12)}`
  const memberCode = 'MEMBER_CODE_1234567890abcdef'
  const friendCode = 'FRIEND_CODE_1234567890abcdef'

  console.log('Household creation')
  await expectAllow('owner creates own household of one', () =>
    setDoc(doc(A.db, 'households', hhA), {
      name: 'A Kitchen', ownerUid: A.uid, memberUids: [A.uid], friendUids: [],
    }),
  )
  await expectAllow('owner creates own profile', () =>
    setDoc(doc(A.db, 'users', A.uid), { email: 'a@kitchen.local', householdIds: [hhA], defaultHouseholdId: hhA }),
  )
  await expectDeny('cannot create a household owned by someone else', () =>
    setDoc(doc(C.db, 'households', 'hh_evil'), {
      name: 'Evil', ownerUid: A.uid, memberUids: [A.uid], friendUids: [],
    }),
  )
  await expectDeny('cannot create a household pre-stuffed with extra members', () =>
    setDoc(doc(C.db, 'households', `hh_${C.uid.slice(0, 12)}`), {
      name: 'C', ownerUid: C.uid, memberUids: [C.uid, A.uid], friendUids: [],
    }),
  )

  console.log('Reads before joining')
  await expectDeny('non-member cannot read the household', () => getDoc(doc(B.db, 'households', hhA)))

  console.log('Invites')
  await expectAllow('member mints a member invite', () =>
    setDoc(doc(A.db, 'invites', memberCode), { householdId: hhA, role: 'member', createdBy: A.uid }),
  )
  await expectAllow('member mints a friend invite', () =>
    setDoc(doc(A.db, 'invites', friendCode), { householdId: hhA, role: 'friend', createdBy: A.uid }),
  )
  await expectDeny('non-member cannot mint an invite for the household', () =>
    setDoc(doc(C.db, 'invites', 'FORGED_CODE_000'), { householdId: hhA, role: 'member', createdBy: C.uid }),
  )
  await expectAllow('anyone signed in can read an invite by code', () => getDoc(doc(B.db, 'invites', memberCode)))

  console.log('Redeeming a member invite')
  await expectDeny('cannot join without staging the invite', () =>
    updateDoc(doc(B.db, 'households', hhA), { memberUids: arrayUnion(B.uid) }),
  )
  await expectAllow('joiner stages the code on their own profile', () =>
    setDoc(doc(B.db, 'users', B.uid), { email: 'b@kitchen.local', pendingInvite: memberCode }),
  )
  await expectDeny('staged invite still cannot add someone other than self', () =>
    updateDoc(doc(B.db, 'households', hhA), { memberUids: arrayUnion(C.uid) }),
  )
  await expectDeny('staged invite cannot also change another field', () =>
    updateDoc(doc(B.db, 'households', hhA), { memberUids: arrayUnion(B.uid), name: 'Hijacked' }),
  )
  await expectAllow('joiner adds only themselves with a valid staged invite', () =>
    updateDoc(doc(B.db, 'households', hhA), { memberUids: arrayUnion(B.uid) }),
  )
  await expectAllow('newly-joined member can now read the household', () => getDoc(doc(B.db, 'households', hhA)))
  await expectDeny('a stranger with no invite cannot add themselves', () =>
    updateDoc(doc(C.db, 'households', hhA), { memberUids: arrayUnion(C.uid) }),
  )

  console.log('Recipes')
  await expectAllow('member creates a recipe in their household', () =>
    setDoc(doc(A.db, 'recipes', 'r1'), { householdId: hhA, visibility: 'household', createdBy: A.uid, title: 'X' }),
  )
  await expectAllow('member creates a friends-visible recipe', () =>
    setDoc(doc(A.db, 'recipes', 'r2'), { householdId: hhA, visibility: 'friends', createdBy: A.uid, title: 'Y' }),
  )
  await expectAllow('joined member reads a household recipe', () => getDoc(doc(B.db, 'recipes', 'r1')))
  await expectDeny('outsider cannot read a household recipe', () => getDoc(doc(C.db, 'recipes', 'r1')))

  console.log('Redeeming a friend invite')
  await expectAllow('friend stages the friend code', () =>
    setDoc(doc(C.db, 'users', C.uid), { email: 'c@kitchen.local', pendingInvite: friendCode }),
  )
  await expectDeny('friend code cannot add the caller as a member', () =>
    updateDoc(doc(C.db, 'households', hhA), { memberUids: arrayUnion(C.uid) }),
  )
  await expectAllow('friend adds only themselves to friendUids', () =>
    updateDoc(doc(C.db, 'households', hhA), { friendUids: arrayUnion(C.uid) }),
  )
  await expectAllow('friend can read a friends-visible recipe', () => getDoc(doc(C.db, 'recipes', 'r2')))
  await expectDeny('friend cannot read a household-only recipe', () => getDoc(doc(C.db, 'recipes', 'r1')))

  // Listing (the guest-switch bug): a member may list every recipe in their
  // household, but a friend may only list ones filtered to visibility 'friends'
  // — an unfiltered listing must be refused (it could return docs they can't
  // read). This is exactly what the app's useRecipes query relies on.
  await expectAllow('member lists all household recipes', () =>
    getDocs(query(collection(B.db, 'recipes'), where('householdId', '==', hhA))),
  )
  await expectDeny('friend cannot list all household recipes (unfiltered)', () =>
    getDocs(query(collection(C.db, 'recipes'), where('householdId', '==', hhA))),
  )
  await expectAllow('friend lists recipes filtered to friends-visible', () =>
    getDocs(
      query(
        collection(C.db, 'recipes'),
        where('householdId', '==', hhA),
        where('visibility', '==', 'friends'),
      ),
    ),
  )

  console.log('Step photos')
  // Photos follow the recipe trust model: members write, members + guests read.
  const IMG = 'data:image/jpeg;base64,AAAA'
  await expectAllow('member creates a photo in their household', () =>
    setDoc(doc(A.db, 'photos', 'ph1'), { householdId: hhA, data: IMG, createdBy: A.uid }),
  )
  await expectAllow('the other member reads the photo', () => getDoc(doc(B.db, 'photos', 'ph1')))
  await expectAllow('a guest (friend) reads the photo', () => getDoc(doc(C.db, 'photos', 'ph1')))
  await expectDeny('a guest cannot add a photo', () =>
    setDoc(doc(C.db, 'photos', 'ph_guest'), { householdId: hhA, data: IMG, createdBy: C.uid }),
  )
  await expectDeny('a member cannot forge another user as the photo creator', () =>
    setDoc(doc(A.db, 'photos', 'ph_forge'), { householdId: hhA, data: IMG, createdBy: B.uid }),
  )
  await expectDeny('an outsider cannot read a photo', async () => {
    const E = await asUser('e-photo@kitchen.local')
    await getDoc(doc(E.db, 'photos', 'ph1'))
  })
  await expectDeny('an outsider cannot add a photo', async () => {
    const E = await asUser('e-photo2@kitchen.local')
    await setDoc(doc(E.db, 'photos', 'ph_evil'), { householdId: hhA, data: IMG, createdBy: E.uid })
  })
  await expectDeny('a guest cannot delete a photo', () => deleteDoc(doc(C.db, 'photos', 'ph1')))
  await expectAllow('a member deletes a photo', () => deleteDoc(doc(A.db, 'photos', 'ph1')))

  console.log('Grocery list')
  // The regression: a member can read the items subcollection BEFORE the parent
  // list doc exists — an empty new list must not permission-deny.
  await expectAllow('member reads the empty items subcollection (no list doc yet)', () =>
    getDocs(collection(A.db, 'lists', hhA, 'items')),
  )
  await expectAllow('member creates a grocery item', () =>
    setDoc(doc(A.db, 'lists', hhA, 'items', 'g1'), { name: 'onion', canonical: 'onion', category: 'produce', checked: false }),
  )
  await expectAllow('the other member reads the item', () => getDoc(doc(B.db, 'lists', hhA, 'items', 'g1')))
  await expectAllow('member creates the parent list doc (ensureList)', () =>
    setDoc(doc(A.db, 'lists', hhA), { householdId: hhA, name: 'Groceries' }),
  )
  await expectDeny('a friend cannot read the grocery items', () =>
    getDocs(collection(C.db, 'lists', hhA, 'items')),
  )
  await expectDeny('a friend cannot add a grocery item', () =>
    setDoc(doc(C.db, 'lists', hhA, 'items', 'sneaky'), { name: 'x', canonical: 'x', category: 'other', checked: false }),
  )
  await expectDeny('an outsider cannot read the grocery items', async () => {
    const E = await asUser('e@kitchen.local')
    await getDocs(collection(E.db, 'lists', hhA, 'items'))
  })

  console.log('Retired meal plan')
  // The meal plan was removed in 0.51; its rules went with it, so any data it
  // left behind falls to the catch-all deny — members included.
  await expectDeny('nobody reads the old meal plan any more (members included)', () =>
    getDocs(collection(A.db, 'plans', hhA, 'entries')),
  )
  await expectDeny('nobody writes to it either', () =>
    setDoc(doc(A.db, 'plans', hhA, 'entries', 'p1'), { recipeSlug: 'r1', recipeTitle: 'X', date: null, scale: 1 }),
  )

  console.log('Cook session')
  await expectAllow('member starts a cook session', () =>
    setDoc(doc(A.db, 'sessions', hhA), { householdId: hhA, recipeSlug: 'r1', stepIndex: 0, timers: [], active: true }),
  )
  await expectAllow('the other member reads and advances the session', () =>
    updateDoc(doc(B.db, 'sessions', hhA), { stepIndex: 1 }),
  )
  await expectDeny('a friend cannot read the cook session', () =>
    getDoc(doc(C.db, 'sessions', hhA)),
  )
  await expectDeny('a friend cannot write the cook session', () =>
    updateDoc(doc(C.db, 'sessions', hhA), { stepIndex: 99 }),
  )
  await expectDeny('an outsider cannot read the cook session', async () => {
    const E = await asUser('e-session@kitchen.local')
    await getDoc(doc(E.db, 'sessions', hhA))
  })

  console.log('Invite revocation')
  await expectAllow('member revokes an invite', () => deleteInvite(A.db, memberCode))
  await expectDeny('a revoked invite can no longer be redeemed', async () => {
    // A brand-new user stages the now-deleted code and tries to join.
    const D = await asUser('d@kitchen.local')
    await setDoc(doc(D.db, 'users', D.uid), { email: 'd@kitchen.local', pendingInvite: memberCode })
    await updateDoc(doc(D.db, 'households', hhA), { memberUids: arrayUnion(D.uid) })
  })

  console.log('Member & role management')
  // Fresh invites (the earlier member code was revoked above), then a second
  // member G and a friend H join, so we can exercise removals and role changes.
  const mgmtMemberCode = 'MGMT_MEMBER_CODE_1234567890'
  const mgmtFriendCode = 'MGMT_FRIEND_CODE_1234567890'
  await setDoc(doc(A.db, 'invites', mgmtMemberCode), { householdId: hhA, role: 'member', createdBy: A.uid })
  await setDoc(doc(A.db, 'invites', mgmtFriendCode), { householdId: hhA, role: 'friend', createdBy: A.uid })

  const G = await asUser('g@kitchen.local')
  await setDoc(doc(G.db, 'users', G.uid), { email: 'g@kitchen.local', pendingInvite: mgmtMemberCode })
  await expectAllow('a second member joins', () =>
    updateDoc(doc(G.db, 'households', hhA), { memberUids: arrayUnion(G.uid) }),
  )
  const H = await asUser('h@kitchen.local')
  await setDoc(doc(H.db, 'users', H.uid), { email: 'h@kitchen.local', pendingInvite: mgmtFriendCode })
  await expectAllow('a friend joins', () =>
    updateDoc(doc(H.db, 'households', hhA), { friendUids: arrayUnion(H.uid) }),
  )

  // Members now: A (owner), B, G. Friends: C, H.
  await expectDeny('a non-owner member cannot remove another member', () =>
    updateDoc(doc(B.db, 'households', hhA), { memberUids: arrayRemove(G.uid) }),
  )
  await expectDeny('a non-owner member cannot change roles (demote)', () =>
    updateDoc(doc(B.db, 'households', hhA), { memberUids: arrayRemove(G.uid), friendUids: arrayUnion(G.uid) }),
  )
  await expectDeny('a non-owner member cannot promote a friend', () =>
    updateDoc(doc(B.db, 'households', hhA), { memberUids: arrayUnion(C.uid), friendUids: arrayRemove(C.uid) }),
  )
  await expectDeny('nobody can remove the owner', () =>
    updateDoc(doc(B.db, 'households', hhA), { memberUids: arrayRemove(A.uid) }),
  )
  await expectDeny('the owner cannot remove themselves', () =>
    updateDoc(doc(A.db, 'households', hhA), { memberUids: arrayRemove(A.uid) }),
  )
  await expectDeny('a member cannot add a friend directly (only via invite)', () =>
    updateDoc(doc(B.db, 'households', hhA), { friendUids: arrayUnion('random_uid') }),
  )
  await expectAllow('a member can remove a friend (guest)', () =>
    updateDoc(doc(B.db, 'households', hhA), { friendUids: arrayRemove(H.uid) }),
  )
  await expectAllow('the owner removes a member', () =>
    updateDoc(doc(A.db, 'households', hhA), { memberUids: arrayRemove(G.uid) }),
  )
  await expectAllow('the owner promotes a friend to member', () =>
    updateDoc(doc(A.db, 'households', hhA), { memberUids: arrayUnion(C.uid), friendUids: arrayRemove(C.uid) }),
  )
  await expectAllow('the owner demotes a member to friend', () =>
    updateDoc(doc(A.db, 'households', hhA), { memberUids: arrayRemove(C.uid), friendUids: arrayUnion(C.uid) }),
  )
  await expectDeny('the owner cannot demote themselves (must stay a member)', () =>
    updateDoc(doc(A.db, 'households', hhA), { memberUids: arrayRemove(A.uid), friendUids: arrayUnion(A.uid) }),
  )
  await expectAllow('a member leaves on their own', () =>
    updateDoc(doc(B.db, 'households', hhA), { memberUids: arrayRemove(B.uid) }),
  )
  await expectAllow('a friend leaves on their own', () =>
    updateDoc(doc(C.db, 'households', hhA), { friendUids: arrayRemove(C.uid) }),
  )
  await expectDeny('an outsider cannot remove a member', async () => {
    const Z = await asUser('z-mgmt@kitchen.local')
    await updateDoc(doc(Z.db, 'households', hhA), { memberUids: arrayRemove(A.uid) })
  })

  // "Made it" + 1–10 scores live on each person's own profile
  // (users/{uid}.cooked.<slug>, src/data/cooked.ts) — no rule of their own:
  // anyone writes their own profile, any signed-in user reads one. These lock
  // that in, and check the merge writes touch only the one recipe's entry.
  console.log('Made it + scores (on your own profile)')
  await expectAllow('a guest marks a recipe made on their own profile', () =>
    setDoc(doc(C.db, 'users', C.uid), { cooked: { r2: { madeAt: 1000 } } }, { merge: true }),
  )
  await expectAllow('…and scores it (merge keeps the date)', () =>
    setDoc(doc(C.db, 'users', C.uid), { cooked: { r2: { rating: 8 } } }, { merge: true }),
  )
  await expectAllow('…and marks another (merge keeps the first)', () =>
    setDoc(doc(C.db, 'users', C.uid), { cooked: { r3: { madeAt: 2000, rating: 6 } } }, { merge: true }),
  )
  await expectAllow('a kitchen member reads what the guest gave it', async () => {
    const data = (await getDoc(doc(A.db, 'users', C.uid))).data()
    const want = JSON.stringify({ r2: { madeAt: 1000, rating: 8 }, r3: { madeAt: 2000, rating: 6 } })
    // Field by field: Firestore doesn't keep a map's key order.
    const entry = (slug: string) => ({ madeAt: data?.cooked?.[slug]?.madeAt, rating: data?.cooked?.[slug]?.rating })
    const got = JSON.stringify({ r2: entry('r2'), r3: entry('r3') })
    if (got !== want) throw new Error(`records were ${got}`)
    if (data?.email !== 'c@kitchen.local') throw new Error('the merge lost a profile field')
  })
  await expectDeny("nobody can score a recipe on someone else's profile", () =>
    setDoc(doc(A.db, 'users', C.uid), { cooked: { r2: { rating: 1 } } }, { merge: true }),
  )
  await expectAllow('"I haven\u2019t made it" removes just that recipe', async () => {
    await setDoc(doc(C.db, 'users', C.uid), { cooked: { r2: deleteField() } }, { merge: true })
    const cooked = (await getDoc(doc(C.db, 'users', C.uid))).data()?.cooked
    if (cooked?.r2 !== undefined || cooked?.r3?.rating !== 6) throw new Error(`records were ${JSON.stringify(cooked)}`)
  })

  // Feedback (src/data/feedback.ts): anyone signed in sends, as themselves;
  // only the OWNER of the kitchen it's addressed to reads it — not a member,
  // not the sender. Private between the two, like a text.
  console.log('Feedback to the owner')
  const F = await asUser('f-feedback@kitchen.local') // signed in, in none of A's kitchens
  const M = await asUser('m-feedback@kitchen.local') // a member of hhA, not its owner
  await setDoc(doc(M.db, 'users', M.uid), { email: 'm-feedback@kitchen.local', pendingInvite: mgmtMemberCode })
  await updateDoc(doc(M.db, 'households', hhA), { memberUids: arrayUnion(M.uid) })
  const note = (uid: string, extra: Record<string, unknown> = {}) => ({
    uid,
    name: 'Fran',
    text: 'The star on the tiles confused me at first',
    householdId: hhA,
    version: '0.55.0 (abc1234)',
    device: 'iPhone · iOS 18.2 · Home Screen app',
    createdAt: serverTimestamp(),
    done: false,
    ...extra,
  })
  await expectAllow('anyone signed in sends feedback to the owner', () =>
    setDoc(doc(F.db, 'feedback', 'fb1'), note(F.uid)),
  )
  await expectDeny("…but not in someone else's name", () => setDoc(doc(F.db, 'feedback', 'fb2'), note(A.uid)))
  await expectDeny('…nor already ticked off', () => setDoc(doc(F.db, 'feedback', 'fb3'), note(F.uid, { done: true })))
  await expectDeny('…nor empty', () => setDoc(doc(F.db, 'feedback', 'fb4'), note(F.uid, { text: '' })))
  await expectDeny('…nor over 2,000 characters', () =>
    setDoc(doc(F.db, 'feedback', 'fb5'), note(F.uid, { text: 'x'.repeat(2001) })),
  )
  await expectDeny('…nor with extra fields', () => setDoc(doc(F.db, 'feedback', 'fb6'), note(F.uid, { admin: true })))
  await expectDeny('…nor backdated', () => setDoc(doc(F.db, 'feedback', 'fb7'), note(F.uid, { createdAt: 1000 })))
  await expectDeny('…nor to a kitchen that does not exist', () =>
    setDoc(doc(F.db, 'feedback', 'fb8'), note(F.uid, { householdId: 'hh_nowhere' })),
  )
  await expectDeny("the sender can't read it back (it's the owner's)", () => getDoc(doc(F.db, 'feedback', 'fb1')))
  await expectDeny("a member who isn't the owner can't read it", () => getDoc(doc(M.db, 'feedback', 'fb1')))
  await expectDeny("…nor list the kitchen's feedback", () =>
    getDocs(query(collection(M.db, 'feedback'), where('householdId', '==', hhA))),
  )
  await expectAllow("the owner lists the kitchen's feedback", async () => {
    const snap = await getDocs(query(collection(A.db, 'feedback'), where('householdId', '==', hhA)))
    if (snap.size !== 1) throw new Error(`expected 1 message, got ${snap.size}`)
  })
  await expectAllow('the owner ticks it off', () => updateDoc(doc(A.db, 'feedback', 'fb1'), { done: true }))
  await expectDeny("the owner can't change what someone said", () =>
    updateDoc(doc(A.db, 'feedback', 'fb1'), { text: 'edited' }),
  )
  await expectDeny("the sender can't tick it off", () => updateDoc(doc(F.db, 'feedback', 'fb1'), { done: false }))
  await expectAllow('the owner deletes it', () => deleteDoc(doc(A.db, 'feedback', 'fb1')))

  await signOut(A.auth)
  await Promise.all([A, B, C, F, M].map((u) => deleteApp(u.app)))

  console.log(`\n${passed} passed, ${failed} failed`)
  // Firestore keeps gRPC streams open, so Node won't exit on its own.
  process.exit(failed > 0 ? 1 : 0)
}

function deleteInvite(db: Firestore, code: string) {
  return import('firebase/firestore').then(({ deleteDoc }) => deleteDoc(doc(db, 'invites', code)))
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
