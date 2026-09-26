import { useEffect, useRef, useState } from 'react'
import { addDoc, collection, doc, getDoc, serverTimestamp } from 'firebase/firestore'
import { db } from '../lib/firebase'

/**
 * Step photos, stored as compressed JPEG data URLs inside Firestore documents
 * (the same approach ConsoliDated uses). We deliberately do NOT use Firebase
 * Storage: enabling a Storage bucket now requires attaching a billing account
 * (the Blaze plan), and this app runs entirely on the free Spark plan. Firestore
 * caps a document at ~1 MB, so we downscale + re-encode the image in the browser
 * until it fits comfortably under that, with headroom for the base64 overhead.
 *
 * A photo lives in the `photos` collection as
 *   { householdId, data: "data:image/jpeg;base64,…", createdBy, createdAt }
 * and a recipe step stores the photo's document id in `Step.images`. The reader,
 * cook mode, and editor resolve those ids back to data URLs with `usePhotoUrls`.
 * firestore.rules gates a photo to its household's members (write) and members +
 * guests (read), so photos follow the same trust model as the recipes they
 * belong to.
 */

// Firestore's hard per-document limit is 1,048,576 bytes. A base64 data URL is
// ASCII (one char per byte), so we budget the string length directly and leave
// headroom for the doc's other fields.
const MAX_DATA_URL_CHARS = 900_000
const MAX_EDGE = 1280 // longest side, px — plenty for a phone screen
const MIN_EDGE = 480 // don't shrink below this chasing the byte budget
const START_QUALITY = 0.82
const MIN_QUALITY = 0.5

interface Source {
  width: number
  height: number
  draw: (ctx: CanvasRenderingContext2D, w: number, h: number) => void
  release: () => void
}

/** Decode a file into something we can redraw at any size. */
async function loadSource(file: File): Promise<Source> {
  // createImageBitmap handles orientation and is fast; fall back to <img>.
  try {
    const bitmap = await createImageBitmap(file)
    return {
      width: bitmap.width,
      height: bitmap.height,
      draw: (ctx, w, h) => ctx.drawImage(bitmap, 0, 0, w, h),
      release: () => bitmap.close(),
    }
  } catch {
    const url = URL.createObjectURL(file)
    try {
      const img = await new Promise<HTMLImageElement>((resolve, reject) => {
        const el = new Image()
        el.onload = () => resolve(el)
        el.onerror = () => reject(new Error('Could not read that image.'))
        el.src = url
      })
      return {
        width: img.naturalWidth,
        height: img.naturalHeight,
        draw: (ctx, w, h) => ctx.drawImage(img, 0, 0, w, h),
        release: () => {},
      }
    } finally {
      URL.revokeObjectURL(url)
    }
  }
}

/** Draw the source onto a canvas scaled to `edge` and encode as a JPEG data URL. */
function encodeAt(source: Source, edge: number, quality: number): string {
  const scale = Math.min(1, edge / Math.max(source.width, source.height))
  const w = Math.max(1, Math.round(source.width * scale))
  const h = Math.max(1, Math.round(source.height * scale))
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('Couldn’t process that image.')
  source.draw(ctx, w, h)
  return canvas.toDataURL('image/jpeg', quality)
}

/**
 * Downscale + re-encode `file` to a JPEG data URL small enough to live in a
 * Firestore doc. Phone photos are several MB; we drop quality first, then
 * dimensions, until the encoded string fits under the budget.
 */
export async function compressToDataUrl(file: File): Promise<string> {
  const source = await loadSource(file)
  try {
    for (let edge = MAX_EDGE; edge >= MIN_EDGE; edge = Math.round(edge * 0.8)) {
      for (let q = START_QUALITY; q >= MIN_QUALITY; q -= 0.1) {
        const url = encodeAt(source, edge, q)
        if (url.length <= MAX_DATA_URL_CHARS) return url
      }
    }
    // Last resort: smallest size + quality we allow.
    const url = encodeAt(source, MIN_EDGE, MIN_QUALITY)
    if (url.length <= MAX_DATA_URL_CHARS) return url
    throw new Error('That photo is too large to add — try a smaller crop.')
  } finally {
    source.release()
  }
}

/**
 * Downscale a photo for AI import (not for storage). Big enough that small
 * recipe text stays legible to the model, but re-encoded so several screenshots
 * can be sent in one request without a huge payload. Unlike compressToDataUrl
 * this isn't chasing the ~1 MB Firestore budget — nothing is stored — so it
 * keeps more resolution. Returns a JPEG data URL.
 */
const IMPORT_MAX_EDGE = 1600 // longest side, px — keeps fine print readable
const IMPORT_QUALITY = 0.85
export async function compressForImport(file: File): Promise<string> {
  const source = await loadSource(file)
  try {
    return encodeAt(source, IMPORT_MAX_EDGE, IMPORT_QUALITY)
  } finally {
    source.release()
  }
}

/**
 * Read a file for AI import as raw base64 (no data-URL prefix). Used for PDFs,
 * which go to the AI as-is: Gemini reads them natively, scanned pages included,
 * so there's nothing to convert or downscale.
 */
export function readFileBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const url = String(reader.result)
      resolve(url.slice(url.indexOf(',') + 1))
    }
    reader.onerror = () => reject(reader.error ?? new Error('Couldn’t read that file.'))
    reader.readAsDataURL(file)
  })
}

/** Store a compressed photo for a household; returns the new photo document id. */
export async function createPhoto(
  householdId: string,
  uid: string,
  dataUrl: string,
): Promise<string> {
  const ref = await addDoc(collection(db, 'photos'), {
    householdId,
    data: dataUrl,
    createdBy: uid,
    createdAt: serverTimestamp(),
  })
  return ref.id
}

/** Read one photo's data URL by id, or null if it's gone / unreadable. */
export async function fetchPhoto(id: string): Promise<string | null> {
  try {
    const snap = await getDoc(doc(db, 'photos', id))
    const data = snap.data()?.data
    return typeof data === 'string' ? data : null
  } catch {
    return null
  }
}

/**
 * Copy a photo into another household so a copied recipe truly owns its images.
 * Firestore reads/writes aren't CORS-restricted (unlike Storage), so we can read
 * the source photo and re-store the bytes in the target household — the copy is
 * fully independent, and removing a photo from one recipe never touches another.
 * Returns the new photo id, or null if the source couldn't be read (the copy
 * just drops that one photo). A `data:` entry is passed through unchanged — it's
 * an unsaved in-memory photo, not a stored one.
 */
export async function copyPhotoToHousehold(
  sourceId: string,
  targetHouseholdId: string,
  uid: string,
): Promise<string | null> {
  if (sourceId.startsWith('data:')) return sourceId
  const data = await fetchPhoto(sourceId)
  if (!data) return null
  return createPhoto(targetHouseholdId, uid, data)
}

/**
 * The renderable `<img src>` for one step-image entry given a resolved map: a
 * transient `data:` URL renders itself immediately; a stored id renders once
 * usePhotoUrls has fetched it (undefined until then, so callers can skip it).
 */
export function photoSrc(entry: string, map: Record<string, string>): string | undefined {
  return entry.startsWith('data:') ? entry : map[entry]
}

/**
 * Resolve step photo ids to their data URLs for display. Entries that are
 * already data URLs — a freshly added, not-yet-saved photo, or a preview fixture
 * — pass through untouched; stored ids are fetched from Firestore once and
 * cached for the session. Returns a map from each entry to a renderable src.
 */
export function usePhotoUrls(ids: string[]): Record<string, string> {
  const [urls, setUrls] = useState<Record<string, string>>({})
  const cache = useRef<Record<string, string>>({})
  // Tolerate a nullish argument (a legacy step with no images) rather than
  // throwing mid-render.
  const list = ids ?? []
  // Only re-run when the actual set of ids changes, not on every render.
  const key = JSON.stringify(list)

  useEffect(() => {
    let alive = true
    const resolved: Record<string, string> = {}
    const missing: string[] = []
    for (const id of list) {
      if (!id) continue
      if (id.startsWith('data:')) resolved[id] = id
      else if (cache.current[id]) resolved[id] = cache.current[id]
      else missing.push(id)
    }
    // Show whatever we can render immediately (data URLs + cached ids).
    setUrls(resolved)
    if (missing.length === 0) return

    void Promise.all(
      missing.map(async (id) => [id, await fetchPhoto(id)] as const),
    ).then((pairs) => {
      if (!alive) return
      const next = { ...resolved }
      for (const [id, data] of pairs) {
        if (data) {
          cache.current[id] = data
          next[id] = data
        }
      }
      setUrls(next)
    })

    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])

  return urls
}

// Note: removing a photo from a recipe only drops the reference from that
// recipe's step — we never delete the `photos` doc from the client. Deletion
// matches recipe deletion (which also leaves photos), and because copies now
// duplicate the bytes into their own household, a delete could only ever orphan
// this recipe's own photo, never blank a copy. Orphaned photo docs are cheap for
// a kitchen this size; a future server-side, reference-aware job could sweep
// them if it's ever worth it.
