import { normalizeTags, TAG_GROUPS } from './tags'
import type { Recipe } from './types'

/**
 * How the kitchen groups its recipes: favorites first, then everything else
 * by course, in the tag list's order (breakfast, appetizers, mains, sides,
 * desserts, snacks, drinks, sauces), then whatever has no course. A recipe
 * tagged with two courses sits under the earlier one (an appetizer that's
 * also a main is an appetizer) — unless a course chip is on, when it sits
 * under the course being looked for. Pure, for test:tags.
 */

export interface KitchenSection {
  key: string
  /** Empty when it's the only section — no heading needed. */
  label: string
  recipes: Recipe[]
}

export const COURSES: string[] = TAG_GROUPS.find((g) => g.key === 'course')?.tags ?? []

const title = (tag: string) => tag.charAt(0).toUpperCase() + tag.slice(1)

/** The course a recipe is filed under (null: it has none). */
export function courseOf(recipe: Recipe, prefer: string[] = []): string | null {
  const own = normalizeTags(recipe.tags)
  const wanted = COURSES.filter((c) => prefer.includes(c) && own.includes(c))
  return wanted[0] ?? COURSES.find((c) => own.includes(c)) ?? null
}

/** Group recipes (already in display order) into the kitchen's sections;
 * `activeTags` = the chips that are on. Empty sections are left out. */
export function kitchenSections(recipes: Recipe[], activeTags: string[] = []): KitchenSection[] {
  const favorites = recipes.filter((r) => r.favorite)
  const byCourse = new Map<string, Recipe[]>()
  const other: Recipe[] = []
  for (const recipe of recipes) {
    if (recipe.favorite) continue
    const course = courseOf(recipe, activeTags)
    if (course) byCourse.set(course, [...(byCourse.get(course) ?? []), recipe])
    else other.push(recipe)
  }
  const courses = COURSES.filter((c) => byCourse.has(c)).map((c) => ({ key: c, label: title(c), recipes: byCourse.get(c)! }))
  const sections: KitchenSection[] = [
    ...(favorites.length ? [{ key: 'favorites', label: 'Favorites', recipes: favorites }] : []),
    ...courses,
  ]
  if (other.length) {
    // "Other" below course headings; "Everything else" below favorites alone;
    // no heading at all when it's the whole kitchen.
    sections.push({ key: 'other', label: courses.length ? 'Other' : favorites.length ? 'Everything else' : '', recipes: other })
  }
  return sections
}
