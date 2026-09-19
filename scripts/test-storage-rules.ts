/**
 * Storage-rules test. Runs under `firebase emulators:exec` with the Firestore,
 * Auth, and Storage emulators, so the storage rule's cross-service
 * `firestore.get()` membership check runs for real. Every op goes through the
 * rules — no admin bypass.
 *
 *   npm run test:storage-rules
 */
import { initializeApp, deleteApp, type FirebaseApp } from 'firebase/app'
import { connectAuthEmulator, createUserWithEmailAndPassword, getAuth } from 'firebase/auth'
import { connectFirestoreEmulator, doc, getFirestore, setDoc, type Firestore } from 'firebase/firestore'
import {
  connectStorageEmulator,
  deleteObject,
  getBytes,
  getStorage,
  ref,
  uploadBytes,
  type FirebaseStorage,
} from 'firebase/storage'

const PROJECT = 'curated-kitchen-rules-test'
let passed = 0
let failed = 0

async function expectAllow(label: string, op: () => Promise<unknown>): Promise<void> {
  try {
    await op()
    console.log(`  ✓ ${label}`)
    passed++
  } catch (error) {
    console.error(`  ✗ ${label} — expected ALLOW: ${(error as Error).message}`)
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
    if (code.includes('unauthorized') || code.includes('permission')) {
      console.log(`  ✓ ${label}`)
      passed++
    } else {
      console.error(`  ✗ ${label} — denied for the wrong reason: ${code} ${(error as Error).message}`)
      failed++
    }
  }
}

interface Client {
  app: FirebaseApp
  uid: string
  db: Firestore
  storage: FirebaseStorage
}

async function asUser(email: string): Promise<Client> {
  const app = initializeApp(
    { apiKey: 'fake', projectId: PROJECT, storageBucket: `${PROJECT}.appspot.com` },
    `app-${email}-${Math.random()}`,
  )
  const auth = getAuth(app)
  connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true })
  const db = getFirestore(app)
  connectFirestoreEmulator(db, '127.0.0.1', 8080)
  const storage = getStorage(app)
  connectStorageEmulator(storage, '127.0.0.1', 9199)
  const cred = await createUserWithEmailAndPassword(auth, email, 'password123')
  return { app, uid: cred.user.uid, db, storage }
}

const IMG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0])
const IMG_META = { contentType: 'image/jpeg' }

async function main(): Promise<void> {
  const A = await asUser('a@kitchen.local') // owner + member
  const B = await asUser('b@kitchen.local') // guest (friend)
  const C = await asUser('c@kitchen.local') // outsider

  const hh = `hh_${A.uid.slice(0, 12)}`
  // Seed the household with A as member and B as a friend. (Seeding B directly
  // is fine here — we're testing storage rules, not the join flow.)
  await setDoc(doc(A.db, 'households', hh), {
    name: 'K',
    ownerUid: A.uid,
    memberUids: [A.uid],
    friendUids: [B.uid],
  })

  const path = `recipe-photos/${hh}/step_1/a.jpg`

  console.log('Step photos')
  await expectAllow('member uploads a step photo', () => uploadBytes(ref(A.storage, path), IMG, IMG_META))
  await expectAllow('member reads the photo', () => getBytes(ref(A.storage, path)))
  await expectAllow('guest (friend) reads the photo', () => getBytes(ref(B.storage, path)))
  await expectDeny('outsider cannot read the photo', () => getBytes(ref(C.storage, path)))
  await expectDeny('guest cannot upload', () =>
    uploadBytes(ref(B.storage, `recipe-photos/${hh}/step_1/g.jpg`), IMG, IMG_META),
  )
  await expectDeny('outsider cannot upload', () =>
    uploadBytes(ref(C.storage, `recipe-photos/${hh}/step_1/x.jpg`), IMG, IMG_META),
  )
  await expectDeny('member cannot upload a non-image', () =>
    uploadBytes(ref(A.storage, `recipe-photos/${hh}/step_1/n.txt`), new Uint8Array([1, 2, 3]), {
      contentType: 'text/plain',
    }),
  )
  await expectDeny('writes outside recipe-photos are denied', () =>
    uploadBytes(ref(A.storage, `other/${hh}/x.jpg`), IMG, IMG_META),
  )
  await expectAllow('member deletes the photo', () => deleteObject(ref(A.storage, path)))

  await Promise.all([A, B, C].map((u) => deleteApp(u.app)))
  console.log(`\n${passed} passed, ${failed} failed`)
  process.exit(failed > 0 ? 1 : 0)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
