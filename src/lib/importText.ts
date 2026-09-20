import { parseRecipe } from './recipeSchema'
import { parseIngredientLine, slugify, type ImportResult } from './importRecipe'
import type { GroceryCategory, RecipeSeed } from './types'

/**
 * Turn pasted recipe text into our authoring shape — a free, on-device
 * alternative to the link/AI importers, for when a site blocks the link route
 * (many big commercial sites do). The cook copies a recipe — the whole page or
 * just the recipe section — and we pull out the title, times, ingredients, and
 * steps by anchoring on the "Ingredients" and "Directions" headings that
 * virtually every recipe page (and most hand-written ones) share, discarding the
 * nav, headnotes, photo credits, captions, reviews, and footer around them.
 *
 * It reuses the same `parseIngredientLine` the link importer uses, and the
 * result lands in the editor for review before saving — so imperfect parsing is
 * fine: a stray caption is one tap to delete, a wrong aisle one tap to fix.
 *
 * Pure and DOM-free (no network, no AI, no cost): runs in the browser and under
 * the test runner alike.
 */

// Header lines that mark the recipe's spine. Kept short so a sentence that
// merely starts with the word can't masquerade as a header.
const INGREDIENTS_HEADER = /^ingredients\b/i
const STEPS_HEADER = /^(directions|instructions|method|preparation|steps)\b/i
// Headers that end a section (and, for a multi-recipe paste, start the next one).
const SECTION_END =
  /^(special equipment|equipment|notes?|nutrition|make[- ]?ahead|storage|read more|related|explore more|reviews?|featured tweaks|community guidelines|you'?ll (also )?need|watch|video)\b/i

function isHeader(line: string, re: RegExp): boolean {
  return re.test(line) && line.length <= 30 && !/[.!?]$/.test(line)
}

/** A photo credit like "Serious Eats / Vicky Wasik" — a source, a slash, a name. */
function isCredit(line: string): boolean {
  if (/^credit:/i.test(line)) return true
  return line.length < 90 && /^[A-Z][\w.'’&-]*(?: [A-Z][\w.'’&-]*)* \/ /.test(line)
}

/** A photo caption, not an instruction. */
function isCaption(line: string): boolean {
  if (/^(photo|collage)\b/i.test(line)) return true
  if (/^\d+\s+(image|photo|sheet|bowl|collage|pan)s?\b/i.test(line)) return true
  // A descriptive, passive sentence ("A bowl full of … is transferred …",
  // "The cooker has been depressurized …") — real steps are imperative and don't
  // open with an article.
  if (/^(a|an|the)\b/i.test(line) && /\b(is|are|was|were|has been|have been|being)\b/i.test(line) && line.length < 160) {
    return true
  }
  return false
}

/** Boilerplate lines that are never part of the recipe itself. */
const JUNK =
  /^(save|rate|rated|print|share|skip to content|newsletters?|sweepstakes|follow us|advertisement|get the app|jump to.*|keep screen awake|in this recipe|show full nutrition label|cancel|submit|my rating|my review|serious eats|never lose a recipe.*|save your favorites.*|save our recipes.*|cook this recipe.*|by\b.*|updated on.*|published on.*|reviews?|\d+ reviews?)$/i

function looksJunkForTitle(line: string): boolean {
  if (!line) return true
  if (JUNK.test(line)) return true
  if (isHeader(line, INGREDIENTS_HEADER) || isHeader(line, STEPS_HEADER)) return true
  if (/^[*\-•]/.test(line)) return true // a bullet (ingredient), not a title
  if (/^\[.*\]\(.*\)$/.test(line)) return true // a bare markdown link
  if (/^https?:\/\//.test(line)) return true
  if (/^[\d.,()]+$/.test(line)) return true // a rating number like "4.9" or "(140)"
  if (!/[a-z]/i.test(line)) return true
  return false
}

/** A rating line ("4.9", "(140)", "422 Reviews") — the title sits just above it. */
function isRatingLine(line: string): boolean {
  return /^\d\.\d$/.test(line) || /^\(\d[\d,]*\)$/.test(line) || /^\d[\d,]*\s+reviews?$/i.test(line)
}

/** Best-effort title: the line just above the rating block, else the first real line. */
function findTitle(lines: string[], ingredientsStart: number): string {
  const top = lines.slice(0, ingredientsStart >= 0 ? ingredientsStart : lines.length)
  const ratingIdx = top.findIndex(isRatingLine)
  if (ratingIdx > 0) {
    for (let i = ratingIdx - 1; i >= 0; i--) {
      if (!looksJunkForTitle(top[i])) return top[i]
    }
  }
  for (const line of top) {
    if (!looksJunkForTitle(line)) return line
  }
  return 'Imported recipe'
}

/** "1 hr 15 mins" → 75, "35 mins" → 35, "2 hrs" → 120. null if no number found. */
function parseHumanDuration(text: string): number | null {
  let total = 0
  let found = false
  const h = text.match(/(\d+)\s*(?:h\b|hr|hrs|hour|hours)/i)
  if (h) {
    total += Number(h[1]) * 60
    found = true
  }
  const m = text.match(/(\d+)\s*(?:m\b|min|mins|minute|minutes)/i)
  if (m) {
    total += Number(m[1])
    found = true
  }
  return found ? total : null
}

/**
 * The value for a "Label:" line — either the text after the colon on the same
 * line, or, when the label sits alone (as recipe pages often format them), the
 * next non-empty line.
 */
function labeledValue(lines: string[], label: RegExp): string | null {
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(label)
    if (!m) continue
    const after = lines[i].slice(m[0].length).replace(/^:\s*/, '').trim()
    if (after) return after
    for (let j = i + 1; j < lines.length; j++) {
      if (lines[j]) return lines[j]
    }
  }
  return null
}

function parseServings(text: string): { amount: number; amountMax: number | null; unit: string } {
  const unit = text.replace(/[\d\s.,–—-]+/g, ' ').replace(/\bto\b/gi, '').trim() || 'servings'
  const range = text.match(/(\d+)\s*(?:-|–|—|to)\s*(\d+)/)
  if (range) return { amount: Number(range[1]), amountMax: Number(range[2]), unit }
  const one = text.match(/(\d+)/)
  return { amount: one ? Number(one[1]) : 4, amountMax: null, unit }
}

function stripBullet(line: string): string {
  return line.replace(/^[*\-•]\s*/, '').trim()
}

/** Split the numbered/paragraph directions block into individual steps. */
function extractSteps(block: string[]): { steps: string[]; captionSeen: boolean } {
  let captionSeen = false
  const clean = block.filter((l) => {
    if (!l) return false
    if (isCredit(l)) return false
    if (isCaption(l)) {
      captionSeen = true
      return false
    }
    if (JUNK.test(l)) return false
    return true
  })

  const numbered = clean.filter((l) => /^\d+[.)]\s/.test(l)).length >= 2
  const steps: string[] = []
  if (numbered) {
    for (const l of clean) {
      const m = l.match(/^\d+[.)]\s+(.*)$/)
      if (m) steps.push(m[1].trim())
      else if (steps.length) steps[steps.length - 1] += ` ${l}` // a continuation line
      else steps.push(l)
    }
  } else {
    steps.push(...clean)
  }

  // A real step is a sentence, not a leftover fragment.
  return { steps: steps.filter((s) => s.length >= 12 && /\s/.test(s)), captionSeen }
}

/** Extract the loose authoring object from pasted text (before validation). */
export function recipeFromText(raw: string): ImportResult {
  const lines = raw.replace(/\r\n?/g, '\n').split('\n').map((l) => l.trim())
  const warnings: string[] = []

  const ingredientsStart = lines.findIndex((l) => isHeader(l, INGREDIENTS_HEADER))
  const stepsStart =
    ingredientsStart >= 0
      ? lines.findIndex((l, i) => i > ingredientsStart && isHeader(l, STEPS_HEADER))
      : -1

  if (ingredientsStart < 0 || stepsStart < 0) {
    throw new Error(
      'Couldn’t find the recipe in that text. Copy the part that includes the ' +
        '“Ingredients” and “Directions” headings and paste it again.',
    )
  }

  // Ingredients: between the two headers, minus bullets, blanks, and sub-headers.
  const ingredientLines = lines
    .slice(ingredientsStart + 1, stepsStart)
    .map(stripBullet)
    .filter((l) => l && !l.endsWith(':') && !JUNK.test(l) && !isHeader(l, SECTION_END))

  // Steps: from the directions header to the next section (Notes, Equipment, a
  // second recipe, …), or the end of the paste.
  let stepsEnd = lines.findIndex(
    (l, i) =>
      i > stepsStart &&
      (isHeader(l, SECTION_END) || isHeader(l, INGREDIENTS_HEADER) || isHeader(l, STEPS_HEADER)),
  )
  if (stepsEnd < 0) stepsEnd = lines.length
  const { steps: stepTexts, captionSeen } = extractSteps(lines.slice(stepsStart + 1, stepsEnd))

  if (ingredientLines.length === 0) {
    throw new Error('No ingredients found under the “Ingredients” heading in that text.')
  }
  if (stepTexts.length === 0) {
    throw new Error('No steps found under the “Directions” heading in that text.')
  }

  // Ingredients → authoring entries (same shape the link importer produces).
  const seenIds = new Map<string, number>()
  const ingredients = ingredientLines.map((line) => {
    const parsed = parseIngredientLine(line)
    if (parsed.category === ('other' as GroceryCategory)) {
      warnings.push(`Guess the aisle for: "${line}" (defaulted to "other").`)
    }
    const base = slugify(parsed.item).replace(/-/g, '_') || 'item'
    const n = seenIds.get(base) ?? 0
    seenIds.set(base, n + 1)
    const id = n === 0 ? base : `${base}_${n + 1}`

    const entry: Record<string, unknown> = { id, item: parsed.item, category: parsed.category, raw: parsed.raw }
    if (parsed.quantity !== null) entry.quantity = parsed.quantity
    if (parsed.quantityMax !== null) entry.quantityMax = parsed.quantityMax
    if (parsed.unit) entry.unit = parsed.unit
    if (parsed.prep) entry.prep = parsed.prep
    if (parsed.alt) entry.alt = parsed.alt
    return entry
  })

  const steps = stepTexts.map((text) => ({ text }))

  // Times + servings live above the ingredients on recipe pages, often with the
  // label on its own line and the value on the next.
  const head = lines.slice(0, ingredientsStart)
  const times = {
    prepMin: numberOrNull(labeledValue(head, /^prep time/i)),
    cookMin: numberOrNull(labeledValue(head, /^cook time/i)),
    totalMin: numberOrNull(labeledValue(head, /^total time/i)),
    activeMin: numberOrNull(labeledValue(head, /^(active|hands[- ]?on) time/i)),
  }
  const servingsText = labeledValue(head, /^servings/i) ?? labeledValue(head, /^yield/i)
  const title = findTitle(lines, ingredientsStart)

  warnings.push(
    'Steps were imported as plain text — add {{ }} tokens for amounts that should scale, and any step timers, by hand.',
  )
  if (captionSeen || steps.length > 0) {
    warnings.push('Review the steps — a photo caption may have slipped in; delete any line that isn’t an instruction.')
  }

  const recipe: Record<string, unknown> = {
    slug: slugify(title),
    title,
    yield: servingsText ? parseServings(servingsText) : { amount: 4, amountMax: null, unit: 'servings' },
    times,
    ingredients,
    steps,
  }
  return { recipe, warnings }
}

function numberOrNull(text: string | null): number | null {
  return text ? parseHumanDuration(text) : null
}

export interface TextImportResult {
  seed: RecipeSeed
  warnings: string[]
}

function randomSuffix(): string {
  return Math.random().toString(36).slice(2, 7)
}

/** Drop empty-string values so optional fields don't trip the validator. */
function stripEmpty<T>(value: T): T {
  return JSON.parse(JSON.stringify(value, (_key, v) => (v === '' ? undefined : v)))
}

/**
 * Parse pasted text into a validated recipe seed, ready for the editor — the
 * same review-before-save path as the link and AI importers.
 */
export function importRecipeFromText(raw: string): TextImportResult {
  if (!raw.trim()) throw new Error('Paste a recipe first.')
  const { recipe, warnings } = recipeFromText(raw)
  const clean = stripEmpty(recipe) as Record<string, unknown>
  const title = typeof clean.title === 'string' ? clean.title : ''
  const withSlug = { ...clean, slug: `${slugify(title) || 'recipe'}-${randomSuffix()}` }
  const parsed = parseRecipe(withSlug)
  return { seed: parsed.recipe, warnings: [...warnings, ...parsed.warnings] }
}
