import { getDownloadURL, ref, uploadBytes } from 'firebase/storage'
import { storage } from '../lib/firebase'

/**
 * Step photos, stored in Firebase Storage (the same approach ConsoliDated uses).
 * Phone photos are huge, so we downscale + re-encode to JPEG in the browser
 * before uploading — a step photo lands around a couple hundred KB instead of
 * several MB, which keeps storage cheap and cook mode snappy on a basement
 * connection.
 *
 * Objects live under recipe-photos/<householdId>/<stepId>/<random>.jpg;
 * storage.rules restricts them to that household's members (write) and
 * members + guests (read), checking membership against the household doc.
 */

const MAX_EDGE = 1600 // longest side, px — plenty for a phone screen
const QUALITY = 0.82

function randomName(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

/** Draw the image onto a scaled canvas and re-encode as a JPEG blob. */
async function compress(file: File): Promise<Blob> {
  // createImageBitmap handles orientation and is fast; fall back to <img>.
  let width: number
  let height: number
  let draw: (ctx: CanvasRenderingContext2D, w: number, h: number) => void

  try {
    const bitmap = await createImageBitmap(file)
    width = bitmap.width
    height = bitmap.height
    draw = (ctx, w, h) => ctx.drawImage(bitmap, 0, 0, w, h)
  } catch {
    const url = URL.createObjectURL(file)
    try {
      const img = await new Promise<HTMLImageElement>((resolve, reject) => {
        const el = new Image()
        el.onload = () => resolve(el)
        el.onerror = () => reject(new Error('Could not read that image.'))
        el.src = url
      })
      width = img.naturalWidth
      height = img.naturalHeight
      draw = (ctx, w, h) => ctx.drawImage(img, 0, 0, w, h)
    } finally {
      URL.revokeObjectURL(url)
    }
  }

  const scale = Math.min(1, MAX_EDGE / Math.max(width, height))
  const w = Math.max(1, Math.round(width * scale))
  const h = Math.max(1, Math.round(height * scale))
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('Couldn’t process that image.')
  draw(ctx, w, h)

  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob(resolve, 'image/jpeg', QUALITY),
  )
  if (!blob) throw new Error('Couldn’t process that image.')
  return blob
}

/**
 * Compress `file` and upload it as a photo for one recipe step. Returns the
 * download URL to store on the step. `householdId` scopes it for the rules;
 * `stepId` groups a step's photos together.
 */
export async function uploadStepPhoto(
  householdId: string,
  stepId: string,
  file: File,
): Promise<string> {
  const blob = await compress(file)
  const path = `recipe-photos/${householdId}/${stepId}/${randomName()}.jpg`
  const objectRef = ref(storage, path)
  await uploadBytes(objectRef, blob, { contentType: 'image/jpeg' })
  return getDownloadURL(objectRef)
}

// Note: removing a photo from a recipe only drops the reference — we never
// delete the Storage file from the client, because a copied recipe shares the
// same file and deleting it would blank the photo on the original too. Orphaned
// files are cheap here; a future server-side, reference-aware job could sweep
// them if it's ever worth it.
