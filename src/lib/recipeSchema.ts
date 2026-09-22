import { z } from 'zod'
import { GROCERY_CATEGORIES, SCHEMA_VERSION } from './types'
import type { Ingredient, RecipeSeed, Step } from './types'
import { parseAmountToken } from './quantity'
import { getUnit, normalizeUnit } from './units'

/**
 * Validation for hand-authored recipes in recipes/*.json.
 *
 * The authoring format is deliberately forgiving — omit anything that isn't
 * true of a given ingredient — but `category` is always required, because a
 * missing aisle is invisible until you're standing in the store.
 */

const nullableString = z.string().trim().min(1).nullable().optional()

const timerInput = z.object({
  label: z.string().trim().min(1),
  seconds: z.number().int().positive(),
})

const temperatureInput = z.object({
  value: z.number(),
  unit: z.enum(['F', 'C']),
  mode: z.enum(['oven', 'internal', 'oil', 'surface', 'water', 'other']).default('oven'),
})

const ingredientInput = z.object({
  id: z.string().trim().min(1).optional(),
  quantity: z.number().positive().nullable().optional(),
  quantityMax: z.number().positive().nullable().optional(),
  unit: z.string().trim().nullable().optional(),
  item: z.string().trim().min(1),
  itemPlural: nullableString,
  canonical: z.string().trim().min(1).optional(),
  prep: nullableString,
  /** A parallel measurement to show in parentheses: 340 g bucatini (12 oz). */
  alt: z
    .object({ quantity: z.number().positive(), unit: z.string().trim().nullable().optional() })
    .nullable()
    .optional(),
  note: nullableString,
  optional: z.boolean().optional(),
  scalable: z.boolean().optional(),
  category: z.enum(GROCERY_CATEGORIES),
  group: nullableString,
  raw: z.string().trim().min(1).optional(),
})

const stepInput = z.object({
  id: z.string().trim().min(1).optional(),
  text: z.string().trim().min(1),
  group: nullableString,
  /** A concise, one-action-per-line version of `text`, shown in cook mode. */
  brief: z.array(z.string().trim().min(1)).optional(),
  /** Ingredient ids or canonical names used in this step. */
  uses: z.array(z.string().trim().min(1)).optional(),
  timers: z.array(timerInput).optional(),
  temperature: temperatureInput.nullable().optional(),
  /** A mostly-unattended wait the cook can step away from (drives cook mode's
   * "work ahead" nudge). Absent = unknown; cook mode falls back to a heuristic. */
  handsOff: z.boolean().optional(),
  /**
   * Up to 3 step photos, shown in the reader and cook mode. Each entry is a
   * `photos` document id (see src/data/photos.ts); a transient `data:` URL may
   * appear only mid-edit, before the editor saves it as a photo doc.
   */
  images: z.array(z.string().trim().min(1)).max(3).optional(),
})

export const recipeInputSchema = z.object({
  slug: z
    .string()
    .trim()
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'slug must be lowercase-kebab-case'),
  title: z.string().trim().min(1),
  subtitle: nullableString,
  description: nullableString,
  source: z
    .object({
      name: nullableString,
      author: nullableString,
      url: z.string().trim().url().nullable().optional(),
      book: nullableString,
      note: nullableString,
    })
    .default({}),
  yield: z.object({
    amount: z.number().positive(),
    amountMax: z.number().positive().nullable().optional(),
    unit: z.string().trim().min(1).default('servings'),
  }),
  times: z
    .object({
      prepMin: z.number().nonnegative().nullable().optional(),
      cookMin: z.number().nonnegative().nullable().optional(),
      totalMin: z.number().nonnegative().nullable().optional(),
      activeMin: z.number().nonnegative().nullable().optional(),
    })
    .default({}),
  ingredients: z.array(ingredientInput).min(1),
  steps: z.array(stepInput).min(1),
  groups: z.array(z.string().trim().min(1)).optional(),
  tags: z.array(z.string().trim().min(1)).optional(),
  equipment: z.array(z.string().trim().min(1)).optional(),
  notes: z.array(z.string().trim().min(1)).optional(),
  images: z.array(z.string().trim()).optional(),
  visibility: z.enum(['private', 'household', 'friends']).default('friends'),
})

export type RecipeInput = z.infer<typeof recipeInputSchema>

export function slugifyIngredient(item: string): string {
  return item
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
}

/** Rebuild the original line when the author didn't supply one. */
function synthesizeRaw(input: z.infer<typeof ingredientInput>): string {
  const amount =
    input.quantity == null
      ? ''
      : input.quantityMax == null
        ? String(input.quantity)
        : `${input.quantity}-${input.quantityMax}`
  const head = [amount, input.unit ?? '', input.item].filter(Boolean).join(' ')
  const withPrep = input.prep ? `${head}, ${input.prep}` : head
  const parenthetical = [
    input.alt ? `${input.alt.quantity}${input.alt.unit ? ` ${input.alt.unit}` : ''}` : '',
    input.note ?? '',
  ]
    .filter(Boolean)
    .join(', ')
  return parenthetical ? `${withPrep} (${parenthetical})` : withPrep
}

export interface ParseResult {
  recipe: RecipeSeed
  warnings: string[]
}

/**
 * Validate and normalize one authored recipe. Throws on anything that would
 * produce a broken recipe; returns warnings for things that are merely
 * suspicious (an unrecognized unit, an ingredient no step mentions).
 */
export function parseRecipe(raw: unknown): ParseResult {
  const input = recipeInputSchema.parse(raw)
  const warnings: string[] = []

  const usedIds = new Set<string>()
  const ingredients: Ingredient[] = input.ingredients.map((entry, index) => {
    const canonical = entry.canonical ?? slugifyIngredient(entry.item)

    let id = entry.id ?? canonical
    if (usedIds.has(id)) {
      id = `${id}_${index}`
    }
    usedIds.add(id)

    let unit: string | null = null
    if (entry.unit) {
      unit = normalizeUnit(entry.unit)
      if (unit === null) {
        warnings.push(
          `ingredient "${entry.item}": unrecognized unit "${entry.unit}" — ` +
            `it will not scale or merge into the grocery list`,
        )
      }
    }

    if (entry.quantityMax != null && entry.quantity != null && entry.quantityMax <= entry.quantity) {
      throw new Error(
        `${input.slug}: ingredient "${entry.item}" has quantityMax ` +
          `(${entry.quantityMax}) at or below quantity (${entry.quantity})`,
      )
    }

    if (entry.quantity == null && entry.quantityMax != null) {
      throw new Error(
        `${input.slug}: ingredient "${entry.item}" has quantityMax without quantity`,
      )
    }

    // A measured amount with no unit means a countable thing ("2 eggs").
    // Flag the case where that's probably an omission instead.
    if (entry.quantity != null && unit === null && !entry.unit && entry.quantity % 1 !== 0) {
      warnings.push(
        `ingredient "${entry.item}": fractional quantity ${entry.quantity} with no unit`,
      )
    }

    return {
      id,
      quantity: entry.quantity ?? null,
      quantityMax: entry.quantityMax ?? null,
      unit,
      item: entry.item,
      itemPlural: entry.itemPlural ?? null,
      canonical,
      prep: entry.prep ?? null,
      alt: entry.alt
        ? { quantity: entry.alt.quantity, unit: normalizeUnit(entry.alt.unit) ?? entry.alt.unit ?? null }
        : null,
      note: entry.note ?? null,
      optional: entry.optional ?? false,
      scalable: entry.scalable ?? true,
      category: entry.category,
      group: entry.group ?? null,
      raw: entry.raw ?? synthesizeRaw(entry),
    }
  })

  const byId = new Map(ingredients.map((i) => [i.id, i]))
  const byCanonical = new Map<string, Ingredient[]>()
  for (const ingredient of ingredients) {
    const bucket = byCanonical.get(ingredient.canonical) ?? []
    bucket.push(ingredient)
    byCanonical.set(ingredient.canonical, bucket)
  }

  const referenced = new Set<string>()
  const steps: Step[] = input.steps.map((entry, index) => {
    // Validate {{ }} amount tokens in both the full text and the concise
    // `brief` lines — both are rendered with scaling, so both must parse.
    for (const source of [entry.text, ...(entry.brief ?? [])]) {
      for (const match of source.matchAll(/\{\{([^{}]*)\}\}/g)) {
        const parsed = parseAmountToken(match[1])
        if (!parsed) {
          throw new Error(
            `${input.slug}: step ${index + 1} has an unreadable amount ` +
              `"{{${match[1]}}}" — expected something like {{1.5 cup}} or {{2}}`,
          )
        }
        if (!parsed.unitRecognized) {
          warnings.push(
            `step ${index + 1}: "{{${match[1]}}}" uses an unrecognized unit — ` +
              `it will scale but may read oddly`,
          )
        }
      }
    }

    const ingredientIds = (entry.uses ?? []).map((ref) => {
      if (byId.has(ref)) return ref
      const matches = byCanonical.get(ref)
      if (matches && matches.length === 1) return matches[0].id
      if (matches && matches.length > 1) {
        throw new Error(
          `${input.slug}: step ${index + 1} refers to "${ref}", which matches ` +
            `${matches.length} ingredients — use an explicit id instead`,
        )
      }
      throw new Error(
        `${input.slug}: step ${index + 1} refers to unknown ingredient "${ref}"`,
      )
    })
    ingredientIds.forEach((id) => referenced.add(id))

    return {
      id: entry.id ?? `step_${index + 1}`,
      text: entry.text,
      group: entry.group ?? null,
      brief: entry.brief ?? [],
      ingredientIds,
      timers: entry.timers ?? [],
      temperature: entry.temperature ?? null,
      ...(entry.handsOff === undefined ? {} : { handsOff: entry.handsOff }),
      images: entry.images ?? [],
    }
  })

  const groups = input.groups ?? []
  const declared = new Set(groups)
  for (const item of [...ingredients, ...steps]) {
    if (item.group && !declared.has(item.group)) {
      throw new Error(
        `${input.slug}: "${item.group}" is used but not listed in "groups"`,
      )
    }
  }

  for (const ingredient of ingredients) {
    if (!referenced.has(ingredient.id)) {
      warnings.push(
        `ingredient "${ingredient.item}" is not used by any step — ` +
          `cook mode won't surface it`,
      )
    }
  }

  for (const ingredient of ingredients) {
    if (ingredient.scalable && ingredient.note && /\d/.test(ingredient.note)) {
      warnings.push(
        `ingredient "${ingredient.item}": note "${ingredient.note}" contains a ` +
          `number that will not scale — move it to "alt" if it's a measurement`,
      )
    }
  }

  // A scalable quantity in a unit we can't convert will scale but may render
  // oddly ("2.5 pinches"), so surface it at author time.
  for (const ingredient of ingredients) {
    const unit = getUnit(ingredient.unit)
    if (unit && unit.toBase === null && ingredient.scalable && ingredient.quantity !== null) {
      warnings.push(
        `ingredient "${ingredient.item}" uses the imprecise unit "${ingredient.unit}" ` +
          `but is marked scalable — consider "scalable": false`,
      )
    }
  }

  return {
    warnings,
    recipe: {
      schemaVersion: SCHEMA_VERSION,
      slug: input.slug,
      title: input.title,
      subtitle: input.subtitle ?? null,
      description: input.description ?? null,
      source: {
        name: input.source.name ?? null,
        author: input.source.author ?? null,
        url: input.source.url ?? null,
        book: input.source.book ?? null,
        note: input.source.note ?? null,
      },
      yield: {
        amount: input.yield.amount,
        amountMax: input.yield.amountMax ?? null,
        unit: input.yield.unit,
      },
      times: {
        prepMin: input.times.prepMin ?? null,
        cookMin: input.times.cookMin ?? null,
        totalMin: input.times.totalMin ?? null,
        activeMin: input.times.activeMin ?? null,
      },
      ingredients,
      steps,
      groups,
      tags: input.tags ?? [],
      equipment: input.equipment ?? [],
      notes: input.notes ?? [],
      images: input.images ?? [],
      visibility: input.visibility,
    },
  }
}
