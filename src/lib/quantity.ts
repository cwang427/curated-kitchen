import type { Ingredient, Times } from './types'
import { convert, getUnit, normalizeUnit, pluralizeWord, unitLabel } from './units'

/**
 * Fractions a cook actually reads off a measuring spoon. Scaled quantities
 * snap to the nearest of these rather than showing "0.333 cup".
 */
const VULGAR: Array<[value: number, glyph: string]> = [
  [0, ''],
  [1 / 8, '⅛'],
  [1 / 6, '⅙'],
  [1 / 4, '¼'],
  [1 / 3, '⅓'],
  [3 / 8, '⅜'],
  [1 / 2, '½'],
  [5 / 8, '⅝'],
  [2 / 3, '⅔'],
  [3 / 4, '¾'],
  [5 / 6, '⅚'],
  [7 / 8, '⅞'],
  [1, ''],
]

const EPSILON = 1e-6

function trimDecimal(value: number): string {
  const rounded =
    value >= 10 ? Math.round(value) : Math.round(value * 100) / 100
  return String(rounded)
}

/** Render a decimal as whole + vulgar fraction: 1.5 → "1½". */
function toFraction(value: number): string {
  const whole = Math.floor(value + EPSILON)
  const remainder = value - whole

  let best = VULGAR[0]
  let bestDistance = Infinity
  for (const entry of VULGAR) {
    const distance = Math.abs(remainder - entry[0])
    if (distance < bestDistance) {
      bestDistance = distance
      best = entry
    }
  }

  // The remainder rounded up to a full unit.
  if (best[0] === 1) return String(whole + 1)

  const wholeText = whole > 0 ? String(whole) : ''
  const text = `${wholeText}${best[1]}`
  // Too small to name as a fraction (< ~1/16) — show the decimal instead.
  return text === '' ? trimDecimal(value) : text
}

export function formatQuantity(value: number, unitKey: string | null): string {
  if (!Number.isFinite(value) || value <= 0) return ''
  const unit = getUnit(unitKey)
  // Countable items with no unit read as fractions too: "1½ onions".
  const fractional = unit ? unit.fractional : true
  return fractional ? toFraction(value) : trimDecimal(value)
}

/**
 * Unit promotions applied when a recipe is scaled — 6 tsp should read as
 * "2 tbsp", not "6 tsp". A step only fires when the converted value lands
 * exactly on `snap`, so we never trade a clean number for an awkward one
 * (4 tsp stays 4 tsp rather than becoming 1⅓ tbsp).
 */
interface LadderStep {
  from: string
  to: string
  minFrom: number
  snap: number
}

const PROMOTIONS: LadderStep[] = [
  { from: 'tsp', to: 'tbsp', minFrom: 3, snap: 0.5 },
  { from: 'tbsp', to: 'cup', minFrom: 4, snap: 0.25 },
  { from: 'cup', to: 'quart', minFrom: 8, snap: 0.25 },
  { from: 'quart', to: 'gallon', minFrom: 8, snap: 0.25 },
  { from: 'g', to: 'kg', minFrom: 1000, snap: 0.05 },
  { from: 'ml', to: 'l', minFrom: 1000, snap: 0.05 },
  { from: 'oz', to: 'lb', minFrom: 16, snap: 0.25 },
]

/** The reverse, for quantities that scaled down below a usable measure. */
const DEMOTIONS: LadderStep[] = [
  { from: 'cup', to: 'tbsp', minFrom: 0, snap: 0.5 },
  { from: 'tbsp', to: 'tsp', minFrom: 0, snap: 0.25 },
  { from: 'kg', to: 'g', minFrom: 0, snap: 1 },
  { from: 'l', to: 'ml', minFrom: 0, snap: 1 },
  { from: 'lb', to: 'oz', minFrom: 0, snap: 0.25 },
]

const DEMOTE_BELOW: Record<string, number> = {
  cup: 0.25,
  tbsp: 1,
  kg: 1,
  l: 1,
  lb: 1,
}

function snapsCleanly(value: number, snap: number): boolean {
  return Math.abs(value / snap - Math.round(value / snap)) < 1e-4
}

/**
 * Pick the unit a cook would rather measure in. Applied only to scaled
 * quantities: at 1x we show exactly what the recipe author wrote.
 */
export function normalizeDisplayUnit(
  value: number,
  unitKey: string | null,
): { value: number; unit: string | null } {
  let current = { value, unit: unitKey }

  for (let i = 0; i < 4; i++) {
    const promotion = PROMOTIONS.find(
      (step) => step.from === current.unit && current.value >= step.minFrom,
    )
    if (!promotion) break
    const converted = convert(current.value, promotion.from, promotion.to)
    if (converted === null || converted < 0.25 || !snapsCleanly(converted, promotion.snap)) break
    current = { value: converted, unit: promotion.to }
  }

  for (let i = 0; i < 4; i++) {
    const threshold = current.unit ? DEMOTE_BELOW[current.unit] : undefined
    if (threshold === undefined || current.value >= threshold) break
    const demotion = DEMOTIONS.find((step) => step.from === current.unit)
    if (!demotion) break
    const converted = convert(current.value, demotion.from, demotion.to)
    if (converted === null || !snapsCleanly(converted, demotion.snap)) break
    current = { value: converted, unit: demotion.to }
  }

  return current
}

export function scaleIngredient(ingredient: Ingredient, factor: number): Ingredient {
  if (factor === 1 || !ingredient.scalable || ingredient.quantity === null) {
    return ingredient
  }
  return {
    ...ingredient,
    quantity: ingredient.quantity * factor,
    quantityMax:
      ingredient.quantityMax === null ? null : ingredient.quantityMax * factor,
    alt:
      ingredient.alt === null
        ? null
        : { ...ingredient.alt, quantity: ingredient.alt.quantity * factor },
  }
}

/** "12 oz", or "" when the ingredient has no alternate measurement. */
function formatAlt(
  alt: Ingredient['alt'],
  normalize: boolean,
): string {
  if (alt === null) return ''
  const display = normalize
    ? normalizeDisplayUnit(alt.quantity, alt.unit)
    : { value: alt.quantity, unit: alt.unit }
  const amount = formatQuantity(display.value, display.unit)
  if (!display.unit) return amount
  return `${amount} ${unitLabel(display.unit, display.value > 1 + EPSILON)}`
}

export interface FormattedIngredient {
  /** "1½", "2–3", or "" when the recipe gives no number. */
  quantity: string
  /** "cups", "g", or "" for countable items. */
  unit: string
  /** "yellow onions" — pluralized to match the quantity. */
  item: string
  prep: string | null
  /** The full parenthetical, alternate measurement and note combined. */
  note: string | null
  optional: boolean
  /** Everything joined, for plain-text contexts like copy-to-clipboard. */
  text: string
}

function pluralizeItem(ingredient: Ingredient, plural: boolean): string {
  if (!plural) return ingredient.item
  if (ingredient.itemPlural) return ingredient.itemPlural
  // Pluralize the head noun, not any trailing qualifier:
  // "sprig of thyme" → "sprigs of thyme".
  const match = ingredient.item.match(/^(.*?)(\s+(?:of|from|for)\s+.*)$/i)
  if (match) return `${pluralizeWord(match[1])}${match[2]}`
  return pluralizeWord(ingredient.item)
}

/**
 * Render an ingredient at a given scale. `factor` of 1 renders the authored
 * form verbatim; anything else may also switch to a friendlier unit.
 */
export function formatIngredient(
  ingredient: Ingredient,
  factor = 1,
): FormattedIngredient {
  const scaled = scaleIngredient(ingredient, factor)

  if (scaled.quantity === null) {
    const item = scaled.item
    const text = [item, scaled.prep].filter(Boolean).join(', ')
    const parenthetical = [formatAlt(scaled.alt, false), scaled.note]
      .filter(Boolean)
      .join(', ')
    return {
      quantity: '',
      unit: scaled.unit ? unitLabel(scaled.unit, true) : '',
      item,
      prep: scaled.prep,
      note: parenthetical || null,
      optional: scaled.optional,
      text: parenthetical ? `${text} (${parenthetical})` : text,
    }
  }

  const shouldNormalize = factor !== 1 && scaled.scalable
  const low = shouldNormalize
    ? normalizeDisplayUnit(scaled.quantity, scaled.unit)
    : { value: scaled.quantity, unit: scaled.unit }

  const quantityText =
    scaled.quantityMax === null
      ? formatQuantity(low.value, low.unit)
      : `${formatQuantity(low.value, low.unit)}–${formatQuantity(
          // Keep both ends of a range in the same unit as the low end.
          convert(scaled.quantityMax, scaled.unit, low.unit) ?? scaled.quantityMax,
          low.unit,
        )}`

  // English takes the singular at or below one: "1 cup", "½ cup", "¾ cup",
  // but "1½ cups". Ranges pluralize off their upper bound.
  const magnitude = scaled.quantityMax ?? low.value
  const plural = magnitude > 1 + EPSILON
  const unitText = low.unit ? unitLabel(low.unit, plural) : ''
  const itemText = low.unit ? scaled.item : pluralizeItem(scaled, plural)

  const parenthetical =
    [formatAlt(scaled.alt, shouldNormalize), scaled.note].filter(Boolean).join(', ') || null

  const head = [quantityText, unitText, itemText].filter(Boolean).join(' ')
  const withPrep = scaled.prep ? `${head}, ${scaled.prep}` : head
  const withNote = parenthetical ? `${withPrep} (${parenthetical})` : withPrep

  return {
    quantity: quantityText,
    unit: unitText,
    item: itemText,
    prep: scaled.prep,
    note: parenthetical,
    optional: scaled.optional,
    text: scaled.optional ? `${withNote} (optional)` : withNote,
  }
}

/** "1 hr 25 min" — nulls render as an empty string. */
export function formatMinutes(minutes: number | null): string {
  if (minutes === null || !Number.isFinite(minutes) || minutes <= 0) return ''
  const hours = Math.floor(minutes / 60)
  const rest = Math.round(minutes % 60)
  if (hours === 0) return `${rest} min`
  if (rest === 0) return `${hours} hr`
  return `${hours} hr ${rest} min`
}

/**
 * A recipe's total time for filtering/sorting: the stated total, else prep +
 * cook when either is given, else the active time. Null when nothing is known.
 */
export function effectiveTotalMinutes(times: Times): number | null {
  if (times.totalMin != null) return times.totalMin
  if (times.prepMin != null || times.cookMin != null) {
    return (times.prepMin ?? 0) + (times.cookMin ?? 0)
  }
  return times.activeMin ?? null
}

/** Scale factors offered in the UI, as [factor, label]. */
export const SCALE_PRESETS: Array<[number, string]> = [
  [0.5, '½×'],
  [1, '1×'],
  [1.5, '1½×'],
  [2, '2×'],
  [3, '3×'],
]

/* ------------------------------------------------------------------ *
 * Quantities written into step text
 *
 * A step that says "reserve 1½ cups of the pasta water" is wrong the moment
 * the recipe is scaled. Wrapping the amount in {{…}} — "reserve
 * {{1.5 cup}} of the pasta water" — lets it scale with everything else.
 * Amounts left as plain prose (times, temperatures, pan sizes) never scale,
 * which is the right default.
 * ------------------------------------------------------------------ */

export type StepSegment =
  | { type: 'text'; value: string }
  | {
      type: 'quantity'
      quantity: number
      quantityMax: number | null
      unit: string | null
    }

const TOKEN_PATTERN = /\{\{([^{}]*)\}\}/g

/** Accepts "2", "1.5", "1/2", and "1 1/2". */
function parseNumber(token: string): number | null {
  const trimmed = token.trim()

  const mixed = trimmed.match(/^(\d+)\s+(\d+)\/(\d+)$/)
  if (mixed) {
    const denominator = Number(mixed[3])
    if (denominator === 0) return null
    return Number(mixed[1]) + Number(mixed[2]) / denominator
  }

  const fraction = trimmed.match(/^(\d+)\/(\d+)$/)
  if (fraction) {
    const denominator = Number(fraction[2])
    if (denominator === 0) return null
    return Number(fraction[1]) / denominator
  }

  if (!/^\d+(?:\.\d+)?$/.test(trimmed)) return null
  return Number(trimmed)
}

const AMOUNT = /^([\d.]+(?:\s+\d+\/\d+)?|\d+\/\d+)(?:\s*(?:-|–|—|to)\s*([\d.]+(?:\s+\d+\/\d+)?|\d+\/\d+))?\s*(.*)$/

export interface ParsedAmount {
  quantity: number
  quantityMax: number | null
  unit: string | null
  /** False when a unit was written but isn't one we know how to convert. */
  unitRecognized: boolean
}

export function parseAmountToken(body: string): ParsedAmount | null {
  const match = body.trim().match(AMOUNT)
  if (!match) return null

  const quantity = parseNumber(match[1])
  if (quantity === null) return null

  const quantityMax = match[2] ? parseNumber(match[2]) : null
  if (match[2] && quantityMax === null) return null
  if (quantityMax !== null && quantityMax <= quantity) return null

  const written = match[3].trim()
  const unit = written ? normalizeUnit(written) : null

  return {
    quantity,
    quantityMax,
    // Keep an unrecognized unit verbatim rather than dropping it.
    unit: unit ?? (written || null),
    unitRecognized: written === '' || unit !== null,
  }
}

/** Split step text into plain runs and scalable amounts. */
export function parseStepText(text: string): StepSegment[] {
  const segments: StepSegment[] = []
  let cursor = 0

  for (const match of text.matchAll(TOKEN_PATTERN)) {
    const start = match.index
    const parsed = parseAmountToken(match[1])
    // An unparseable token stays as literal text rather than vanishing.
    if (!parsed) continue

    if (start > cursor) {
      segments.push({ type: 'text', value: text.slice(cursor, start) })
    }
    segments.push({
      type: 'quantity',
      quantity: parsed.quantity,
      quantityMax: parsed.quantityMax,
      unit: parsed.unit,
    })
    cursor = start + match[0].length
  }

  if (cursor < text.length) {
    segments.push({ type: 'text', value: text.slice(cursor) })
  }
  return segments
}

export function formatStepQuantity(
  segment: Extract<StepSegment, { type: 'quantity' }>,
  factor = 1,
): string {
  const scaled = segment.quantity * factor
  const display =
    factor === 1
      ? { value: scaled, unit: segment.unit }
      : normalizeDisplayUnit(scaled, segment.unit)

  const low = formatQuantity(display.value, display.unit)
  const high =
    segment.quantityMax === null
      ? null
      : formatQuantity(
          convert(segment.quantityMax * factor, segment.unit, display.unit) ??
            segment.quantityMax * factor,
          display.unit,
        )

  const magnitude = segment.quantityMax === null ? display.value : segment.quantityMax * factor
  const amount = high ? `${low}–${high}` : low
  if (!display.unit) return amount
  return `${amount} ${unitLabel(display.unit, magnitude > 1 + EPSILON)}`
}
