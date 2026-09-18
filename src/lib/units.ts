import type { Dimension } from './types'

export interface UnitDef {
  key: string
  dimension: Dimension
  singular: string
  plural: string
  /** Multiplier to the dimension's base unit (g for mass, ml for volume). */
  toBase: number | null
  /**
   * True when cooks read this unit as fractions ("¾ cup") rather than
   * decimals ("0.75 cup"). Grams and millilitres are not fractional.
   */
  fractional: boolean
}

function def(
  key: string,
  dimension: Dimension,
  singular: string,
  plural: string,
  toBase: number | null,
  fractional: boolean,
): UnitDef {
  return { key, dimension, singular, plural, toBase, fractional }
}

/** Count units get toBase 1 so that "2 cloves + 1 clove" can still merge. */
const COUNT_UNITS = [
  'clove', 'sprig', 'stalk', 'stick', 'head', 'bunch', 'ear', 'leaf',
  'slice', 'piece', 'strip', 'fillet', 'rib', 'bulb', 'wedge', 'segment',
  'can', 'jar', 'bottle', 'package', 'box', 'bag', 'container', 'loaf',
  'sheet', 'link', 'breast', 'thigh', 'wing',
]

/**
 * Deliberately not convertible: a pinch is not a reproducible fraction of a
 * teaspoon, so toBase is null and these never merge or scale numerically.
 */
const VAGUE_UNITS = ['pinch', 'dash', 'handful', 'splash', 'drizzle', 'knob', 'glug']

const UNIT_LIST: UnitDef[] = [
  // mass — base gram
  def('g', 'mass', 'g', 'g', 1, false),
  def('kg', 'mass', 'kg', 'kg', 1000, false),
  def('mg', 'mass', 'mg', 'mg', 0.001, false),
  def('oz', 'mass', 'oz', 'oz', 28.349523125, true),
  def('lb', 'mass', 'lb', 'lb', 453.59237, true),

  // volume — base millilitre
  def('ml', 'volume', 'ml', 'ml', 1, false),
  def('l', 'volume', 'L', 'L', 1000, false),
  def('tsp', 'volume', 'tsp', 'tsp', 4.92892159375, true),
  def('tbsp', 'volume', 'tbsp', 'tbsp', 14.78676478125, true),
  def('cup', 'volume', 'cup', 'cups', 236.5882365, true),
  def('floz', 'volume', 'fl oz', 'fl oz', 29.5735295625, true),
  def('pint', 'volume', 'pint', 'pints', 473.176473, true),
  def('quart', 'volume', 'quart', 'quarts', 946.352946, true),
  def('gallon', 'volume', 'gallon', 'gallons', 3785.411784, true),

  // length
  def('inch', 'length', 'inch', 'inches', 25.4, true),
  def('cm', 'length', 'cm', 'cm', 10, false),

  ...COUNT_UNITS.map((u) => def(u, 'count', u, pluralizeWord(u), 1, true)),
  ...VAGUE_UNITS.map((u) => def(u, 'count', u, pluralizeWord(u), null, true)),
]

const UNITS = new Map(UNIT_LIST.map((u) => [u.key, u]))

/** Input spellings we accept in recipe JSON, normalized to a canonical key. */
const ALIASES: Record<string, string> = {
  gram: 'g', grams: 'g', gm: 'g', gs: 'g',
  kilogram: 'kg', kilograms: 'kg',
  milligram: 'mg', milligrams: 'mg',
  ounce: 'oz', ounces: 'oz',
  pound: 'lb', pounds: 'lb', lbs: 'lb',
  milliliter: 'ml', millilitre: 'ml', milliliters: 'ml', millilitres: 'ml',
  liter: 'l', litre: 'l', liters: 'l', litres: 'l',
  teaspoon: 'tsp', teaspoons: 'tsp', t: 'tsp', tsps: 'tsp',
  tablespoon: 'tbsp', tablespoons: 'tbsp', tbs: 'tbsp', tbl: 'tbsp', tbsps: 'tbsp',
  cups: 'cup', c: 'cup',
  'fluid ounce': 'floz', 'fluid ounces': 'floz', 'fl oz': 'floz', ozfl: 'floz',
  pints: 'pint', pt: 'pint',
  quarts: 'quart', qt: 'quart',
  gallons: 'gallon', gal: 'gallon',
  inches: 'inch', in: 'inch', '"': 'inch',
  centimeter: 'cm', centimetre: 'cm', centimeters: 'cm', centimetres: 'cm',
}

function pluralizeWord(word: string): string {
  if (/(s|x|z|ch|sh)$/i.test(word)) return `${word}es`
  if (/[^aeiou]y$/i.test(word)) return `${word.slice(0, -1)}ies`
  return `${word}s`
}

/** Resolve a written unit to its canonical key, or null if we don't know it. */
export function normalizeUnit(raw: string | null | undefined): string | null {
  if (!raw) return null
  const key = raw.trim().toLowerCase()
  if (UNITS.has(key)) return key
  const singular = ALIASES[key]
  if (singular) return singular
  const depluralized = key.replace(/s$/, '')
  if (UNITS.has(depluralized)) return depluralized
  return null
}

export function getUnit(key: string | null | undefined): UnitDef | null {
  if (!key) return null
  return UNITS.get(key) ?? null
}

export function dimensionOf(key: string | null | undefined): Dimension {
  return getUnit(key)?.dimension ?? 'unitless'
}

/** True when two units measure the same kind of thing and both convert. */
export function isCompatible(a: string | null, b: string | null): boolean {
  if (a === b) return true
  const ua = getUnit(a)
  const ub = getUnit(b)
  if (!ua || !ub) return false
  if (ua.toBase === null || ub.toBase === null) return false
  return ua.dimension === ub.dimension
}

/** Convert within a dimension. Returns null when the conversion is unsafe. */
export function convert(value: number, from: string | null, to: string | null): number | null {
  if (from === to) return value
  const uf = getUnit(from)
  const ut = getUnit(to)
  if (!uf || !ut || uf.dimension !== ut.dimension) return null
  if (uf.toBase === null || ut.toBase === null) return null
  return (value * uf.toBase) / ut.toBase
}

export function unitLabel(key: string | null, plural: boolean): string {
  const u = getUnit(key)
  if (!u) return key ?? ''
  return plural ? u.plural : u.singular
}

export { pluralizeWord }
