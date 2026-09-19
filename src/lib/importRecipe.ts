import { GROCERY_CATEGORIES, type GroceryCategory } from './types'
import { normalizeUnit } from './units'

/**
 * Convert a schema.org/Recipe (the JSON-LD most recipe sites embed for search
 * engines) into our authoring format — the same shape as recipes/*.json.
 *
 * This is best-effort and deliberately conservative: it extracts what the
 * markup states plainly (title, times, yield, ingredient lines, steps) and
 * *guesses* only the things a human should confirm — an ingredient's aisle
 * (`category`) and whether it scales. Every guess is surfaced as a warning so
 * the draft gets reviewed before it's synced, never trusted blind.
 *
 * Pure and DOM-free, so it runs in the import script and under the test runner.
 */

export interface ImportResult {
  /** Authoring JSON, ready to write to recipes/<slug>.json (after review). */
  recipe: Record<string, unknown>
  warnings: string[]
}

const CATEGORY_SET = new Set<string>(GROCERY_CATEGORIES)

/** Keyword → aisle. First match wins; order matters (specific before generic). */
const CATEGORY_HINTS: Array<[RegExp, GroceryCategory]> = [
  // "ground" only counts as meat next to an animal — otherwise it's
  // "freshly ground black pepper", which is a spice.
  [/\b(short ribs?|beef|steaks?|chuck|brisket|pork|bacon|sausages?|chicken|thighs?|breasts?|lamb|veal|ground (?:beef|pork|lamb|turkey|chicken|veal|meat))\b/i, 'meat'],
  [/\b(salmon|tuna|shrimp|prawns?|cod|halibut|fish|scallops?|clams?|mussels?|anchov(?:y|ies))\b/i, 'seafood'],
  [/\b(milk|cream|butter|yogurt|yoghurt|cheese|parmesan|pecorino|mozzarella|mascarpone|crème fraîche|sour cream|eggs?)\b/i, 'dairy'],
  [/\b(flour|sugar|baking soda|baking powder|yeast|cornstarch|cocoa|vanilla extract)\b/i, 'baking'],
  [/\b(salt|pepper|peppercorns?|cumin|paprika|cinnamon|nutmeg|coriander|turmeric|cayenne|chili powder|spice|bay lea)\b/i, 'spices'],
  [/\b(soy sauce|fish sauce|vinegar|mustard|ketchup|mayonnaise|honey|maple syrup|hoisin|sriracha|worcestershire|miso|sesame oil)\b/i, 'condiments'],
  [/\b(oils?|olive oil|stock|broth|rice|pasta|noodles?|beans?|lentils?|canned|can of|tomato paste|coconut milk)\b/i, 'pantry'],
  [/\b(wine|beer|sake|sherry|vermouth|bourbon|brandy|rum)\b/i, 'alcohol'],
  [/\b(bread|baguette|ciabatta|tortillas?|buns?|rolls?|loaf)\b/i, 'bakery'],
  // Trailing plural forms handled per-noun (tomato→tomatoes, potato→potatoes).
  [/\b(onions?|garlic|ginger|shallots?|scallions?|leeks?|carrots?|celery|potatoe?s?|tomatoe?s?|peppers?|chil[ei]s?|lemons?|limes?|oranges?|herbs?|parsley|cilantro|basil|thyme|rosemary|mushrooms?|spinach|kale|lettuce|cucumbers?|zucchini|squash|apples?|greens?)\b/i, 'produce'],
]

function guessCategory(item: string): { category: GroceryCategory; confident: boolean } {
  for (const [pattern, category] of CATEGORY_HINTS) {
    if (pattern.test(item)) return { category, confident: true }
  }
  return { category: 'other', confident: false }
}

export function slugify(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
}

/** "1", "1.5", "1/2", "1 1/2", "¾" → number, or null. */
function parseNumber(raw: string): number | null {
  const vulgar: Record<string, number> = {
    '½': 0.5, '⅓': 1 / 3, '⅔': 2 / 3, '¼': 0.25, '¾': 0.75,
    '⅛': 0.125, '⅜': 0.375, '⅝': 0.625, '⅞': 0.875,
  }
  let s = raw.trim()
  for (const [glyph, value] of Object.entries(vulgar)) {
    // "1½" or "½"
    if (s.includes(glyph)) {
      const whole = s.replace(glyph, '').trim()
      const base = whole ? Number(whole) : 0
      return Number.isFinite(base) ? base + value : value
    }
  }
  const mixed = s.match(/^(\d+)\s+(\d+)\/(\d+)$/)
  if (mixed) return Number(mixed[1]) + Number(mixed[2]) / Number(mixed[3])
  const frac = s.match(/^(\d+)\/(\d+)$/)
  if (frac) return Number(frac[1]) / Number(frac[2])
  if (/^\d+(\.\d+)?$/.test(s)) return Number(s)
  return null
}

interface ParsedLine {
  quantity: number | null
  quantityMax: number | null
  unit: string | null
  item: string
  prep: string | null
  alt: { quantity: number; unit: string | null } | null
  category: GroceryCategory
  raw: string
}

// Fraction and mixed-number forms are listed before the bare number so that
// "1/2" matches the fraction, not just the leading "1".
const AMT = String.raw`\d+\s+\d+\/\d+|\d+\/\d+|[\d.¼-¾⅐-⅞]+`
const AMOUNT_HEAD = new RegExp(`^\\s*(${AMT})\\s*(?:(?:-|–|—|to)\\s*(${AMT})\\s*)?`)

/** Pull a "(30ml)" / "(1.8kg)" style metric aside out of a line, if present. */
function extractAlt(text: string): { alt: ParsedLine['alt']; rest: string } {
  const paren = text.match(/\(([^)]*)\)/)
  if (paren) {
    const inner = paren[1].trim()
    const m = inner.match(/^([\d.]+)\s*([a-zA-Z]+)$/)
    if (m) {
      const unit = normalizeUnit(m[2])
      return {
        alt: { quantity: Number(m[1]), unit: unit ?? m[2] },
        rest: text.replace(paren[0], ' ').replace(/\s+/g, ' ').trim(),
      }
    }
  }
  return { alt: null, rest: text }
}

export function parseIngredientLine(raw: string): ParsedLine {
  const line = raw.trim()

  // Metric aside first, so it doesn't confuse quantity/unit detection.
  const { alt, rest: withoutAlt } = extractAlt(line)

  let quantity: number | null = null
  let quantityMax: number | null = null
  let rest = withoutAlt

  const head = withoutAlt.match(AMOUNT_HEAD)
  if (head && head[1]) {
    quantity = parseNumber(head[1])
    quantityMax = head[2] ? parseNumber(head[2]) : null
    rest = withoutAlt.slice(head[0].length).trim()
  }

  // Unit is the next word, if we recognize it.
  let unit: string | null = null
  const firstWord = rest.match(/^(\S+)\s+(.*)$/)
  if (firstWord) {
    const maybe = normalizeUnit(firstWord[1].replace(/\.$/, ''))
    if (maybe) {
      unit = maybe
      rest = firstWord[2].trim()
    }
  }

  // Prep is whatever follows the first comma.
  let item = rest
  let prep: string | null = null
  const comma = rest.indexOf(',')
  if (comma !== -1) {
    item = rest.slice(0, comma).trim()
    prep = rest.slice(comma + 1).trim() || null
  }

  const { category } = guessCategory(`${item} ${prep ?? ''}`)

  return { quantity, quantityMax, unit, item, prep, alt, category, raw: line }
}

/** ISO-8601 duration ("PT2H30M") → minutes, or null. */
export function parseDuration(iso: unknown): number | null {
  if (typeof iso !== 'string') return null
  const m = iso.match(/^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?/)
  if (!m || (!m[1] && !m[2] && !m[3])) return null
  return (Number(m[1] ?? 0) * 24 * 60) + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0)
}

function parseYield(value: unknown): { amount: number; amountMax: number | null; unit: string } {
  const text = Array.isArray(value) ? String(value[0]) : String(value ?? '')
  const range = text.match(/(\d+)\s*(?:-|–|—|to)\s*(\d+)/)
  if (range) {
    return {
      amount: Number(range[1]),
      amountMax: Number(range[2]),
      unit: text.replace(range[0], '').trim() || 'servings',
    }
  }
  const single = text.match(/(\d+)/)
  return {
    amount: single ? Number(single[1]) : 4,
    amountMax: null,
    unit: text.replace(/\d+/, '').trim() || 'servings',
  }
}

function textOf(node: unknown): string {
  if (typeof node === 'string') return node
  if (node && typeof node === 'object' && 'text' in node) return String((node as { text: unknown }).text)
  return ''
}

/** recipeInstructions can be strings, HowToStep objects, or HowToSections. */
function flattenSteps(instructions: unknown): string[] {
  const out: string[] = []
  const visit = (node: unknown) => {
    if (Array.isArray(node)) {
      node.forEach(visit)
      return
    }
    if (node && typeof node === 'object') {
      const obj = node as Record<string, unknown>
      if (obj['@type'] === 'HowToSection' && obj.itemListElement) {
        visit(obj.itemListElement)
        return
      }
      const text = textOf(obj).trim()
      if (text) out.push(text)
      return
    }
    const text = textOf(node).trim()
    if (text) out.push(text)
  }
  visit(instructions)
  return out
}

function asArray(value: unknown): unknown[] {
  if (value == null) return []
  return Array.isArray(value) ? value : [value]
}

function firstString(value: unknown): string | null {
  if (typeof value === 'string') return value.trim() || null
  if (Array.isArray(value)) {
    for (const v of value) {
      const s = firstString(v)
      if (s) return s
    }
  }
  if (value && typeof value === 'object' && 'name' in value) {
    return firstString((value as { name: unknown }).name)
  }
  return null
}

/** The site's display name for the `source`: "www.seriouseats.com" → "seriouseats.com". */
function hostName(url: string): string | null {
  try {
    return new URL(url).hostname.replace(/^www\./, '') || null
  } catch {
    return null
  }
}

/** Find the Recipe node inside a parsed JSON-LD blob (handles @graph, arrays). */
export function findRecipeNode(jsonld: unknown): Record<string, unknown> | null {
  const isRecipe = (node: unknown): node is Record<string, unknown> => {
    if (!node || typeof node !== 'object') return false
    const type = (node as Record<string, unknown>)['@type']
    return Array.isArray(type) ? type.includes('Recipe') : type === 'Recipe'
  }
  const search = (node: unknown): Record<string, unknown> | null => {
    if (isRecipe(node)) return node
    if (Array.isArray(node)) {
      for (const n of node) {
        const found = search(n)
        if (found) return found
      }
    }
    if (node && typeof node === 'object' && '@graph' in node) {
      return search((node as { '@graph': unknown })['@graph'])
    }
    return null
  }
  return search(jsonld)
}

export function recipeFromJsonLd(jsonld: unknown, sourceUrl: string): ImportResult {
  const node = findRecipeNode(jsonld)
  if (!node) {
    throw new Error('No schema.org/Recipe found in the page. It may not publish structured data.')
  }
  const warnings: string[] = []

  const title = firstString(node.name) ?? 'Imported recipe'
  const author = firstString(node.author)
  const rawIngredients = asArray(node.recipeIngredient).map(String).filter(Boolean)
  const rawSteps = flattenSteps(node.recipeInstructions)

  if (rawIngredients.length === 0) warnings.push('No ingredients found in the structured data.')
  if (rawSteps.length === 0) warnings.push('No instructions found in the structured data.')

  const seenIds = new Map<string, number>()
  const ingredients = rawIngredients.map((raw) => {
    const parsed = parseIngredientLine(raw)

    if (parsed.category === 'other') {
      warnings.push(`Guess the aisle for: "${raw}" (defaulted to "other").`)
    }
    if (parsed.quantity !== null && parsed.unit === null && !/^\d/.test(parsed.item)) {
      // Countable (e.g. "2 oranges") is fine; only note truly odd cases.
    }

    // Stable id from the item name, de-duplicated.
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

  const steps = rawSteps.map((text) => ({ text }))

  const times = {
    prepMin: parseDuration(node.prepTime),
    cookMin: parseDuration(node.cookTime),
    totalMin: parseDuration(node.totalTime),
    activeMin: null as number | null,
  }

  const tags = [...asArray(node.recipeCategory), ...asArray(node.recipeCuisine), ...asArray(node.keywords)]
    .flatMap((t) => String(t).split(','))
    .map((t) => t.trim().toLowerCase())
    .filter(Boolean)

  warnings.push(
    'Steps were imported as plain text — add {{ }} tokens for amounts and any step timers by hand.',
  )

  // The publication name comes from the page's own publisher, falling back to
  // the site's hostname — never hardcoded, since this imports from any site.
  const sourceName = firstString(node.publisher) ?? hostName(sourceUrl)

  const recipe: Record<string, unknown> = {
    slug: slugify(title),
    title,
    source: {
      name: sourceName,
      author,
      url: sourceUrl,
    },
    yield: parseYield(node.recipeYield),
    times,
    ingredients,
    steps,
    tags: [...new Set(tags)],
    // visibility is left to the schema default (shared with the kitchen); a
    // member can hide it after review in the editor.
  }

  const description = firstString(node.description)
  if (description) recipe.subtitle = description

  return { recipe, warnings }
}

export { CATEGORY_SET }
