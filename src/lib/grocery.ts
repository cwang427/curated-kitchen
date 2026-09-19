import { formatIngredient, scaleIngredient } from './quantity'
import { convert, getUnit, isCompatible, unitLabel } from './units'
import { GROCERY_CATEGORIES, type GroceryCategory, type GroceryItem, type Ingredient } from './types'

/**
 * Grocery-list logic: turning recipe ingredients into shopping-list additions,
 * merging duplicates, and grouping by aisle. Pure and DOM-free so it's testable
 * and shared between the app and any scripts.
 */

/** What an add-from-recipe (or a manual quick-add) contributes to the list. */
export interface Addition {
  name: string
  canonical: string
  quantity: number | null
  quantityMax: number | null
  unit: string | null
  category: GroceryCategory
  note: string | null
}

/** Build an addition from a recipe ingredient at a given scale. */
export function additionFromIngredient(ingredient: Ingredient, scale: number): Addition {
  const scaled = scaleIngredient(ingredient, scale)
  return {
    name: ingredient.item,
    canonical: ingredient.canonical,
    quantity: scaled.quantity,
    quantityMax: scaled.quantityMax,
    unit: scaled.unit,
    category: ingredient.category,
    note: null,
  }
}

export interface MergePlan {
  /** New items to create. */
  creates: Addition[]
  /** Existing items to bump, with their new combined amount. */
  updates: Array<{ id: string; quantity: number | null; quantityMax: number | null; unit: string | null }>
}

/**
 * Fold additions into the current list. An addition merges into an existing
 * *unchecked* item with the same canonical name and a compatible unit — summing
 * the amounts in the existing item's unit. Anything else becomes a new item.
 * Checked items are left alone, so re-adding after you've shopped starts fresh.
 */
const NEW_PREFIX = 'new-'

export function planMerge(existing: GroceryItem[], additions: Addition[]): MergePlan {
  // Remember each existing item's amount so we only emit an update if it moved.
  const originals = new Map(existing.map((i) => [i.id, { quantity: i.quantity, quantityMax: i.quantityMax }]))

  // A single mutable snapshot of the unchecked list. Additions merge into it —
  // including into items created earlier in this same batch — so both
  // "existing + addition" and "addition + addition" fold together.
  const live = existing.filter((item) => !item.checked).map((item) => ({ ...item }))
  let newCount = 0

  for (const addition of additions) {
    const target = live.find(
      (item) => item.canonical === addition.canonical && isCompatible(item.unit, addition.unit),
    )

    if (!target) {
      live.push({
        id: `${NEW_PREFIX}${newCount++}`,
        name: addition.name,
        canonical: addition.canonical,
        quantity: addition.quantity,
        quantityMax: addition.quantityMax,
        unit: addition.unit,
        category: addition.category,
        checked: false,
        note: addition.note,
        addedBy: null,
        createdAt: null,
        updatedAt: null,
      })
      continue
    }

    // Both quantified → sum in the target's unit. Either side null (e.g. "salt
    // to taste") → leave the amount as it is; the item is already on the list.
    if (target.quantity !== null && addition.quantity !== null) {
      const add = convert(addition.quantity, addition.unit, target.unit) ?? addition.quantity
      const addMax =
        addition.quantityMax === null
          ? null
          : convert(addition.quantityMax, addition.unit, target.unit) ?? addition.quantityMax
      target.quantity += add
      // A range only survives if both sides had one; otherwise collapse it.
      target.quantityMax = target.quantityMax !== null && addMax !== null ? target.quantityMax + addMax : null
    }
  }

  const creates: Addition[] = live
    .filter((item) => item.id.startsWith(NEW_PREFIX))
    .map((item) => ({
      name: item.name,
      canonical: item.canonical,
      quantity: item.quantity,
      quantityMax: item.quantityMax,
      unit: item.unit,
      category: item.category,
      note: item.note,
    }))

  const updates: MergePlan['updates'] = live
    .filter((item) => !item.id.startsWith(NEW_PREFIX))
    .filter((item) => {
      const original = originals.get(item.id)
      return original && (original.quantity !== item.quantity || original.quantityMax !== item.quantityMax)
    })
    .map((item) => ({ id: item.id, quantity: item.quantity, quantityMax: item.quantityMax, unit: item.unit }))

  return { creates, updates }
}

/** Render a grocery item's amount, e.g. "3", "1½ cups", "2–3", "" for none. */
export function formatGroceryAmount(item: GroceryItem): string {
  if (item.quantity === null) return ''
  // Reuse the ingredient formatter at scale 1 (the stored amount is final).
  const formatted = formatIngredient(
    {
      id: item.id,
      quantity: item.quantity,
      quantityMax: item.quantityMax,
      unit: item.unit,
      item: '',
      itemPlural: null,
      canonical: item.canonical,
      prep: null,
      alt: null,
      note: null,
      optional: false,
      scalable: true,
      category: item.category,
      group: null,
      raw: '',
    },
    1,
  )
  return [formatted.quantity, formatted.unit].filter(Boolean).join(' ').trim()
}

const CATEGORY_LABELS: Record<GroceryCategory, string> = {
  produce: 'Produce',
  meat: 'Meat',
  seafood: 'Seafood',
  dairy: 'Dairy & eggs',
  bakery: 'Bakery',
  deli: 'Deli',
  frozen: 'Frozen',
  pantry: 'Pantry',
  spices: 'Spices',
  condiments: 'Condiments & sauces',
  baking: 'Baking',
  beverages: 'Beverages',
  alcohol: 'Beer, wine & spirits',
  household: 'Household',
  other: 'Other',
}

export function categoryLabel(category: GroceryCategory): string {
  return CATEGORY_LABELS[category] ?? category
}

export interface AisleGroup {
  category: GroceryCategory
  label: string
  items: GroceryItem[]
}

/**
 * Group items into aisles in store-walking order, alphabetized within each
 * aisle. Only aisles with items appear.
 */
export function groupByAisle(items: GroceryItem[]): AisleGroup[] {
  const byCategory = new Map<GroceryCategory, GroceryItem[]>()
  for (const item of items) {
    const bucket = byCategory.get(item.category) ?? []
    bucket.push(item)
    byCategory.set(item.category, bucket)
  }
  return GROCERY_CATEGORIES.filter((category) => byCategory.has(category)).map((category) => ({
    category,
    label: categoryLabel(category),
    items: (byCategory.get(category) ?? []).sort((a, b) => a.name.localeCompare(b.name)),
  }))
}

/** A readable unit label for a manual quick-add, or '' when there's no unit. */
export function unitDisplay(unit: string | null): string {
  if (!unit) return ''
  return getUnit(unit) ? unitLabel(unit, true) : unit
}

/** A merge key / id from a free-typed name, matching Ingredient.canonical style. */
export function canonicalize(name: string): string {
  return (
    name
      .toLowerCase()
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '') || 'item'
  )
}
