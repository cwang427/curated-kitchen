import { GROCERY_CATEGORIES } from './types'
import { parseAmountToken } from './quantity'
import { slugifyIngredient } from './recipeSchema'

/**
 * Tidy an AI-extracted recipe into something `parseRecipe` will accept.
 *
 * The model's JSON is best-effort: it omits fields the source doesn't show (an
 * Apple Note with no servings), writes "{{½ cup}}" with a unicode fraction, or
 * returns a timer with no seconds. Our validator is strict on purpose (it guards
 * hand-authored recipes too), so one such slip would reject an otherwise good
 * import. This fills the gaps honestly (a missing yield becomes "1 batch", not
 * an invented serving count) and drops any piece that can't be made valid,
 * rather than failing the whole recipe. The cook reviews everything in the
 * editor before saving, so anything dropped can be re-added there.
 *
 * Pure and DOM-free (unit-tested by `npm run test:ai`).
 */

type Obj = Record<string, unknown>

const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)
const str = (v: unknown): string | undefined =>
  typeof v === 'string' && v.trim() ? v.trim() : undefined
const pos = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : undefined
const nonNeg = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined
const bool = (v: unknown): boolean | undefined => (typeof v === 'boolean' ? v : undefined)
const httpUrl = (v: unknown): string | undefined => {
  const s = str(v)
  if (!s || !/^https?:\/\//i.test(s)) return undefined
  try { new URL(s); return s } catch { return undefined }
}
const strList = (v: unknown): string[] =>
  Array.isArray(v) ? v.map(str).filter((s): s is string => s !== undefined) : []

const VULGAR: Record<string, string> = {
  '½': '1/2', '⅓': '1/3', '⅔': '2/3', '¼': '1/4', '¾': '3/4', '⅕': '1/5', '⅖': '2/5',
  '⅗': '3/5', '⅘': '4/5', '⅙': '1/6', '⅚': '5/6', '⅛': '1/8', '⅜': '3/8', '⅝': '5/8', '⅞': '7/8',
}

/** "1½" → "1 1/2", "½" → "1/2" — the {{ }} amount grammar is ASCII-only. */
function asciiFractions(s: string): string {
  return s
    .replace(/(\d)\s*([½⅓⅔¼¾⅕⅖⅗⅘⅙⅚⅛⅜⅝⅞])/g, (_m, d: string, f: string) => `${d} ${VULGAR[f]}`)
    .replace(/[½⅓⅔¼¾⅕⅖⅗⅘⅙⅚⅛⅜⅝⅞]/g, (f) => VULGAR[f])
    .replace(/⁄/g, '/')
}

/**
 * Keep each {{ }} amount token only if it parses (after normalizing unicode
 * fractions); otherwise unwrap it to plain text, so "{{a pinch}}" reads as
 * "a pinch" instead of failing the import.
 */
export function repairTokens(text: string): string {
  return text.replace(/\{\{([^{}]*)\}\}/g, (_m, body: string) => {
    const fixed = asciiFractions(body).trim()
    return parseAmountToken(fixed) ? `{{${fixed}}}` : body.trim()
  })
}

function ingredient(v: unknown): Obj | null {
  if (!isObj(v)) return null
  const item = str(v.item)
  if (!item) return null
  let quantity = pos(v.quantity)
  let quantityMax = pos(v.quantityMax)
  // "up to 2 cups" can arrive as a max with no min; treat it as the amount.
  if (quantity === undefined && quantityMax !== undefined) [quantity, quantityMax] = [quantityMax, undefined]
  if (quantity !== undefined && quantityMax !== undefined && quantityMax <= quantity) quantityMax = undefined
  const category = GROCERY_CATEGORIES.includes(v.category as never) ? v.category : 'other'
  const altQty = isObj(v.alt) ? pos(v.alt.quantity) : undefined
  return {
    quantity,
    quantityMax,
    unit: str(v.unit),
    item,
    itemPlural: str(v.itemPlural),
    canonical: str(v.canonical),
    prep: str(v.prep),
    note: str(v.note),
    optional: bool(v.optional),
    scalable: bool(v.scalable),
    category,
    group: str(v.group),
    alt: altQty !== undefined && isObj(v.alt) ? { quantity: altQty, unit: str(v.alt.unit) } : undefined,
  }
}

function timer(v: unknown): Obj | null {
  if (!isObj(v)) return null
  const label = str(v.label)
  const seconds = pos(v.seconds)
  if (!label || seconds === undefined) return null
  return { label, seconds: Math.max(1, Math.round(seconds)) }
}

const MODES = ['oven', 'internal', 'oil', 'surface', 'water', 'other']

function temperature(v: unknown): Obj | undefined {
  if (!isObj(v) || typeof v.value !== 'number' || !Number.isFinite(v.value)) return undefined
  const unit = typeof v.unit === 'string' ? v.unit.replace(/[^a-z]/gi, '').toUpperCase() : ''
  if (unit !== 'F' && unit !== 'C') return undefined
  return { value: v.value, unit, mode: MODES.includes(v.mode as string) ? v.mode : undefined }
}

function step(v: unknown, canonicals: Map<string, number>): Obj | null {
  if (!isObj(v)) return null
  const brief = strList(v.brief).map(repairTokens).filter((l) => l.trim())
  // A step that only came back as bullets still keeps its instruction, since
  // `text` must be the complete prose.
  const text = str(v.text) ?? (brief.length ? brief.map((l) => (/[.!?]$/.test(l) ? l : `${l}.`)).join(' ') : undefined)
  if (!text) return null
  // Keep only links that name exactly one ingredient; parseRecipe rejects the rest.
  const uses = strList(v.uses).filter((u) => canonicals.get(u) === 1)
  return {
    text: repairTokens(text),
    brief: brief.length ? brief : undefined,
    group: str(v.group),
    uses: uses.length ? uses : undefined,
    timers: Array.isArray(v.timers) ? v.timers.map(timer).filter((t): t is Obj => t !== null) : undefined,
    temperature: temperature(v.temperature),
    handsOff: bool(v.handsOff),
  }
}

/** Why an AI answer can't become a recipe at all (nothing to salvage). */
export class AiRecipeError extends Error {}

/**
 * Normalize the model's raw recipe into the loose authoring shape `parseRecipe`
 * validates (the caller adds the slug). Throws `AiRecipeError` only when there's
 * no title, ingredient, or step to work with.
 */
export function sanitizeAiRecipe(raw: unknown): Obj {
  if (!isObj(raw)) throw new AiRecipeError('The AI didn’t return a recipe.')

  const ingredients = (Array.isArray(raw.ingredients) ? raw.ingredients : [])
    .map(ingredient)
    .filter((i): i is Obj => i !== null)
  const canonicals = new Map<string, number>()
  for (const i of ingredients) {
    const c = (i.canonical as string | undefined) ?? slugifyIngredient(i.item as string)
    canonicals.set(c, (canonicals.get(c) ?? 0) + 1)
  }
  const steps = (Array.isArray(raw.steps) ? raw.steps : [])
    .map((s) => step(s, canonicals))
    .filter((s): s is Obj => s !== null)

  if (!ingredients.length && !steps.length) {
    throw new AiRecipeError('Couldn’t find a recipe in that — no ingredients or steps came through.')
  }
  if (!ingredients.length) throw new AiRecipeError('Couldn’t find any ingredients in that.')
  if (!steps.length) throw new AiRecipeError('Couldn’t find any steps in that.')

  // A missing yield is common (a quick note rarely says "serves 4"). Default to
  // "1 batch" rather than inventing a serving count; the cook can change it.
  const y = isObj(raw.yield) ? raw.yield : {}
  const amount = pos(y.amount)
  const amountMax = pos(y.amountMax)
  const unit = str(y.unit)
  const yieldOut = amount
    ? { amount, amountMax: amountMax && amountMax > amount ? amountMax : undefined, unit: unit ?? 'servings' }
    : { amount: 1, unit: unit && !/^servings?$/i.test(unit) ? unit : 'batch' }

  const t = isObj(raw.times) ? raw.times : {}
  const src = isObj(raw.source) ? raw.source : {}

  // Every group a line uses must be declared, or parseRecipe refuses it.
  const groups = [
    ...new Set([
      ...strList(raw.groups),
      ...[...ingredients, ...steps].map((x) => x.group as string | undefined).filter((g): g is string => !!g),
    ]),
  ]

  return {
    title: str(raw.title) ?? 'Untitled recipe',
    subtitle: str(raw.subtitle),
    description: str(raw.description),
    source: { name: str(src.name), author: str(src.author), url: httpUrl(src.url) },
    yield: yieldOut,
    times: {
      prepMin: nonNeg(t.prepMin),
      cookMin: nonNeg(t.cookMin),
      totalMin: nonNeg(t.totalMin),
      activeMin: nonNeg(t.activeMin),
    },
    ingredients,
    steps,
    groups,
    tags: strList(raw.tags),
    equipment: strList(raw.equipment),
    notes: strList(raw.notes),
  }
}
