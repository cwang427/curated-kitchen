import type {
  GroceryCategory,
  Ingredient,
  RecipeSeed,
  Temperature,
  Timer,
  Visibility,
} from './types'

/**
 * The editable form shape for a recipe, and the conversions to/from the
 * validated schema. Numbers are held as strings (so inputs behave naturally)
 * and converted on save; fields the editor doesn't expose yet (alt measurements,
 * step timers/temperature, step↔ingredient links) ride along untouched as
 * passthrough so editing never silently drops them. Pure and DOM-free, so it's
 * unit-tested like the rest of `src/lib/`.
 */

export interface DraftIngredient {
  /** Stable id so step↔ingredient links survive edits/reorders. */
  id: string
  quantity: string
  quantityMax: string
  unit: string
  item: string
  prep: string
  note: string
  category: GroceryCategory
  optional: boolean
  scalable: boolean
  // Passthrough (not edited in the form yet).
  alt: Ingredient['alt']
  itemPlural: string | null
  group: string | null
}

export interface DraftStep {
  /** Stable within the editing session; groups a step's photos and preserves
   * identity across reorders. */
  id: string
  text: string
  /** Concise cook-mode lines, one per line of this textarea. */
  brief: string
  /**
   * Step photos (up to 3), edited directly (add/remove) in the editor. Holds
   * `photos` doc ids for saved photos and transient `data:` URLs for ones added
   * this session but not yet saved; the editor turns the latter into photo docs
   * on save. See src/data/photos.ts.
   */
  images: string[]
  // Passthrough.
  uses: string[]
  timers: Timer[]
  temperature: Temperature | null
  group: string | null
}

export interface RecipeDraft {
  title: string
  subtitle: string
  description: string
  sourceName: string
  sourceAuthor: string
  sourceUrl: string
  yieldAmount: string
  yieldAmountMax: string
  yieldUnit: string
  prepMin: string
  cookMin: string
  totalMin: string
  activeMin: string
  tags: string
  equipment: string
  notes: string
  visibility: Visibility
  ingredients: DraftIngredient[]
  steps: DraftStep[]
  groups: string[]
}

let idCounter = 0
export function newIngredientId(): string {
  return `new_${Date.now()}_${idCounter++}`
}

export function newStepId(): string {
  return `step_${Date.now()}_${idCounter++}`
}

/** Parse a quantity field: decimals, fractions, and mixed numbers. null = blank/invalid. */
export function parseAmount(input: string): number | null {
  const s = input.trim()
  if (!s) return null
  const mixed = s.match(/^(\d+)\s+(\d+)\/(\d+)$/)
  if (mixed) return Number(mixed[1]) + Number(mixed[2]) / Number(mixed[3])
  const frac = s.match(/^(\d+)\/(\d+)$/)
  if (frac) return Number(frac[2]) ? Number(frac[1]) / Number(frac[2]) : null
  const num = Number(s)
  return Number.isFinite(num) ? num : null
}

function numToStr(n: number | null): string {
  return n === null || n === undefined ? '' : String(n)
}

export function blankIngredient(): DraftIngredient {
  return {
    id: newIngredientId(),
    quantity: '', quantityMax: '', unit: '', item: '', prep: '', note: '',
    category: 'other', optional: false, scalable: true,
    alt: null, itemPlural: null, group: null,
  }
}

export function blankStep(): DraftStep {
  return { id: newStepId(), text: '', brief: '', images: [], uses: [], timers: [], temperature: null, group: null }
}

export function blankDraft(): RecipeDraft {
  return {
    title: '', subtitle: '', description: '',
    sourceName: '', sourceAuthor: '', sourceUrl: '',
    yieldAmount: '4', yieldAmountMax: '', yieldUnit: 'servings',
    prepMin: '', cookMin: '', totalMin: '', activeMin: '',
    tags: '', equipment: '', notes: '', visibility: 'friends',
    ingredients: [blankIngredient()],
    steps: [blankStep()],
    groups: [],
  }
}

export function seedToDraft(seed: RecipeSeed): RecipeDraft {
  return {
    title: seed.title,
    subtitle: seed.subtitle ?? '',
    description: seed.description ?? '',
    sourceName: seed.source.name ?? '',
    sourceAuthor: seed.source.author ?? '',
    sourceUrl: seed.source.url ?? '',
    yieldAmount: numToStr(seed.yield.amount),
    yieldAmountMax: numToStr(seed.yield.amountMax),
    yieldUnit: seed.yield.unit,
    prepMin: numToStr(seed.times.prepMin),
    cookMin: numToStr(seed.times.cookMin),
    totalMin: numToStr(seed.times.totalMin),
    activeMin: numToStr(seed.times.activeMin),
    tags: seed.tags.join(', '),
    equipment: seed.equipment.join('\n'),
    notes: seed.notes.join('\n'),
    // The editor offers two states now — shared with everyone ('friends') or
    // members-only ('household'). Collapse the legacy 'private' onto members-only.
    visibility: seed.visibility === 'friends' ? 'friends' : 'household',
    groups: seed.groups,
    ingredients: seed.ingredients.map((i) => ({
      id: i.id,
      quantity: numToStr(i.quantity),
      quantityMax: numToStr(i.quantityMax),
      unit: i.unit ?? '',
      item: i.item,
      prep: i.prep ?? '',
      note: i.note ?? '',
      category: i.category,
      optional: i.optional,
      scalable: i.scalable,
      alt: i.alt,
      itemPlural: i.itemPlural,
      group: i.group,
    })),
    steps: seed.steps.map((s) => ({
      id: s.id || newStepId(),
      text: s.text,
      brief: (s.brief ?? []).join('\n'),
      images: s.images ?? [],
      uses: s.ingredientIds,
      timers: s.timers,
      temperature: s.temperature,
      group: s.group,
    })),
  }
}

function lines(text: string): string[] {
  return text.split('\n').map((l) => l.trim()).filter(Boolean)
}
function commaList(text: string): string[] {
  return text.split(',').map((t) => t.trim()).filter(Boolean)
}
function orUndef(s: string): string | undefined {
  const t = s.trim()
  return t ? t : undefined
}

/**
 * Convert the draft to the loose authoring shape `parseRecipe` validates. The
 * caller adds a `slug`. Step `uses` are filtered to ingredients that still
 * exist, so deleting an ingredient can't leave a dangling link that fails
 * validation.
 */
export function draftToInput(draft: RecipeDraft): Record<string, unknown> {
  const ids = new Set(draft.ingredients.map((i) => i.id))
  return {
    title: draft.title.trim(),
    subtitle: orUndef(draft.subtitle),
    description: orUndef(draft.description),
    source: {
      name: orUndef(draft.sourceName),
      author: orUndef(draft.sourceAuthor),
      url: orUndef(draft.sourceUrl),
    },
    yield: {
      amount: parseAmount(draft.yieldAmount) ?? 1,
      amountMax: parseAmount(draft.yieldAmountMax) ?? undefined,
      unit: draft.yieldUnit.trim() || 'servings',
    },
    times: {
      prepMin: parseAmount(draft.prepMin) ?? undefined,
      cookMin: parseAmount(draft.cookMin) ?? undefined,
      totalMin: parseAmount(draft.totalMin) ?? undefined,
      activeMin: parseAmount(draft.activeMin) ?? undefined,
    },
    ingredients: draft.ingredients.map((i) => ({
      id: i.id,
      quantity: parseAmount(i.quantity) ?? undefined,
      quantityMax: parseAmount(i.quantityMax) ?? undefined,
      unit: orUndef(i.unit),
      item: i.item.trim(),
      itemPlural: i.itemPlural ?? undefined,
      prep: orUndef(i.prep),
      note: orUndef(i.note),
      optional: i.optional,
      scalable: i.scalable,
      category: i.category,
      group: i.group ?? undefined,
      alt: i.alt ?? undefined,
    })),
    steps: draft.steps.map((s) => {
      const brief = lines(s.brief)
      return {
        id: s.id,
        text: s.text.trim(),
        brief: brief.length ? brief : undefined,
        images: s.images.length ? s.images : undefined,
        uses: s.uses.filter((u) => ids.has(u)),
        timers: s.timers,
        temperature: s.temperature ?? undefined,
        group: s.group ?? undefined,
      }
    }),
    groups: draft.groups,
    tags: commaList(draft.tags),
    equipment: lines(draft.equipment),
    notes: lines(draft.notes),
    visibility: draft.visibility,
  }
}
