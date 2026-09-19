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
  arrayUnion,
  collection,
  connectFirestoreEmulator,
  doc,
  getDoc,
  getDocs,
  getFirestore,
  setDoc,
  updateDoc,
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

  console.log('Meal plan')
  // Same regression guard as the grocery list: the entries subcollection must
  // read before the parent plan doc exists.
  await expectAllow('member reads the empty plan entries (no plan doc yet)', () =>
    getDocs(collection(A.db, 'plans', hhA, 'entries')),
  )
  await expectAllow('member creates the parent plan doc', () =>
    setDoc(doc(A.db, 'plans', hhA), { householdId: hhA }),
  )
  await expectAllow('member adds a plan entry', () =>
    setDoc(doc(A.db, 'plans', hhA, 'entries', 'p1'), { recipeSlug: 'r1', recipeTitle: 'X', date: null, scale: 1 }),
  )
  await expectAllow('the other member reads the plan entry', () =>
    getDoc(doc(B.db, 'plans', hhA, 'entries', 'p1')),
  )
  await expectDeny('a friend cannot read the meal plan', () =>
    getDocs(collection(C.db, 'plans', hhA, 'entries')),
  )
  await expectDeny('a friend cannot add a plan entry', () =>
    setDoc(doc(C.db, 'plans', hhA, 'entries', 'sneaky'), { recipeSlug: 'r2', recipeTitle: 'Y', date: null, scale: 1 }),
  )
  await expectDeny('an outsider cannot read the meal plan', async () => {
    const E = await asUser('e-plan@kitchen.local')
    await getDocs(collection(E.db, 'plans', hhA, 'entries'))
  })

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

  await signOut(A.auth)
  await Promise.all([A, B, C].map((u) => deleteApp(u.app)))

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
