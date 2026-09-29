/**
 * Recipe tags are a fixed list, grouped the way people browse and filter a
 * kitchen: what course it is, what cuisine, what kind of dish, dietary needs,
 * and when you'd make it. Anything else — a main ingredient ("beef"), a method
 * or gadget ("pressure cooker"), a region finer than a cuisine ("roman") — just
 * cluttered the kitchen's filter row. Ingredients are already searchable
 * (search reads the ingredient list), and the time filter covers "quick".
 *
 * Every source of tags goes through normalizeTags: AI imports (the Worker is
 * also told to pick from this list), a page's recipe data, and the editor, which
 * offers these as a picker. Old recipes keep whatever tags they were saved
 * with, but the app only ever shows or filters by their normalized form, and
 * the editor drops the rest on the next save.
 *
 * No React/DOM here — the Worker imports this list too.
 */

export interface TagGroup {
  key: 'course' | 'cuisine' | 'dish' | 'diet' | 'occasion'
  label: string
  tags: string[]
}

export const TAG_GROUPS: TagGroup[] = [
  {
    key: 'course',
    label: 'Course',
    // Breakfast after desserts, not first: it's a time of day rather than a
    // course, so in the kitchen's sections Mains leads, and a dish that's both
    // (shakshuka) files under Mains.
    tags: ['appetizers', 'mains', 'sides', 'desserts', 'breakfast', 'snacks', 'drinks', 'sauces'],
  },
  {
    key: 'cuisine',
    label: 'Cuisine',
    tags: [
      'african',
      'american',
      'british',
      'caribbean',
      'chinese',
      'filipino',
      'french',
      'german',
      'greek',
      'indian',
      'italian',
      'japanese',
      'korean',
      'latin-american',
      'mediterranean',
      'mexican',
      'middle-eastern',
      'southeast-asian',
      'spanish',
      'thai',
      'vietnamese',
    ],
  },
  {
    key: 'dish',
    label: 'Dish',
    tags: [
      'soup',
      'stew',
      'salad',
      'pasta',
      'noodles',
      'rice',
      'curry',
      'stir-fry',
      'sandwich',
      'pizza',
      'tacos',
      'dumplings',
      'casserole',
      'bread',
      'cake',
      'cookies',
      'pie',
    ],
  },
  {
    key: 'diet',
    label: 'Diet',
    tags: ['vegetarian', 'vegan', 'pescatarian', 'gluten-free', 'dairy-free'],
  },
  {
    key: 'occasion',
    label: 'Occasion',
    tags: ['weeknight', 'make-ahead', 'holiday'],
  },
]

/** Every allowed tag, in display order (course → cuisine → dish → diet → occasion). */
export const ALL_TAGS: string[] = TAG_GROUPS.flatMap((g) => g.tags)

const RANK = new Map(ALL_TAGS.map((tag, i) => [tag, i]))

/** Other names for an allowed tag (keys hyphenated, like the tags). */
const SYNONYMS: Record<string, string> = {
  // course
  'main': 'mains',
  'main-course': 'mains',
  'main-courses': 'mains',
  'main-dish': 'mains',
  'main-dishes': 'mains',
  'entree': 'mains',
  'entrée': 'mains',
  'entrees': 'mains',
  'dinner': 'mains',
  'side': 'sides',
  'side-dish': 'sides',
  'side-dishes': 'sides',
  'dessert': 'desserts',
  'appetizer': 'appetizers',
  'starter': 'appetizers',
  'starters': 'appetizers',
  'hors-d’oeuvres': 'appetizers',
  "hors-d'oeuvres": 'appetizers',
  'snack': 'snacks',
  'drink': 'drinks',
  'beverage': 'drinks',
  'beverages': 'drinks',
  'cocktail': 'drinks',
  'cocktails': 'drinks',
  'brunch': 'breakfast',
  'sauce': 'sauces',
  'condiment': 'sauces',
  'condiments': 'sauces',
  'dressing': 'sauces',
  'dressings': 'sauces',
  // cuisine — regions fold into their cuisine
  'roman': 'italian',
  'sicilian': 'italian',
  'tuscan': 'italian',
  'neapolitan': 'italian',
  'venetian': 'italian',
  'italian-american': 'italian',
  'cantonese': 'chinese',
  'sichuan': 'chinese',
  'szechuan': 'chinese',
  'hunan': 'chinese',
  'shanghainese': 'chinese',
  'southern': 'american',
  'cajun': 'american',
  'creole': 'american',
  'new-england': 'american',
  'southwestern': 'american',
  'tex-mex': 'mexican',
  'lebanese': 'middle-eastern',
  'israeli': 'middle-eastern',
  'persian': 'middle-eastern',
  'iranian': 'middle-eastern',
  'turkish': 'middle-eastern',
  'levantine': 'middle-eastern',
  'syrian': 'middle-eastern',
  'palestinian': 'middle-eastern',
  'middle-east': 'middle-eastern',
  'south-indian': 'indian',
  'north-indian': 'indian',
  'punjabi': 'indian',
  'provencal': 'french',
  'provençal': 'french',
  'catalan': 'spanish',
  'basque': 'spanish',
  'english': 'british',
  'scottish': 'british',
  'welsh': 'british',
  'peruvian': 'latin-american',
  'brazilian': 'latin-american',
  'argentinian': 'latin-american',
  'argentine': 'latin-american',
  'colombian': 'latin-american',
  'venezuelan': 'latin-american',
  'latin': 'latin-american',
  'jamaican': 'caribbean',
  'cuban': 'caribbean',
  'puerto-rican': 'caribbean',
  'dominican': 'caribbean',
  'haitian': 'caribbean',
  'trinidadian': 'caribbean',
  'ethiopian': 'african',
  'moroccan': 'african',
  'nigerian': 'african',
  'west-african': 'african',
  'north-african': 'african',
  'south-african': 'african',
  'tunisian': 'african',
  'malaysian': 'southeast-asian',
  'indonesian': 'southeast-asian',
  'singaporean': 'southeast-asian',
  'burmese': 'southeast-asian',
  'cambodian': 'southeast-asian',
  'laotian': 'southeast-asian',
  // dish
  'soups': 'soup',
  'stews': 'stew',
  'salads': 'salad',
  'noodle': 'noodles',
  'ramen': 'noodles',
  'udon': 'noodles',
  'soba': 'noodles',
  'pho': 'noodles',
  'lo-mein': 'noodles',
  'spaghetti': 'pasta',
  'lasagna': 'pasta',
  'risotto': 'rice',
  'fried-rice': 'rice',
  'pilaf': 'rice',
  'biryani': 'rice',
  'paella': 'rice',
  'curries': 'curry',
  'stir-fries': 'stir-fry',
  'stirfry': 'stir-fry',
  'sandwiches': 'sandwich',
  'burger': 'sandwich',
  'burgers': 'sandwich',
  'pizzas': 'pizza',
  'taco': 'tacos',
  'dumpling': 'dumplings',
  'casseroles': 'casserole',
  'breads': 'bread',
  'muffins': 'bread',
  'scones': 'bread',
  'biscuits': 'bread',
  'cakes': 'cake',
  'cupcakes': 'cake',
  'cookie': 'cookies',
  'brownies': 'cookies',
  'bars': 'cookies',
  'pies': 'pie',
  'tart': 'pie',
  'tarts': 'pie',
  // diet
  'veggie': 'vegetarian',
  'meatless': 'vegetarian',
  'plant-based': 'vegan',
  'pescetarian': 'pescatarian',
  'gluten-free-recipes': 'gluten-free',
  'gf': 'gluten-free',
  'non-dairy': 'dairy-free',
  // occasion
  'weeknights': 'weeknight',
  'weeknight-dinner': 'weeknight',
  'weeknight-dinners': 'weeknight',
  'make-ahead-meals': 'make-ahead',
  'meal-prep': 'make-ahead',
  'holidays': 'holiday',
  'thanksgiving': 'holiday',
  'christmas': 'holiday',
  'easter': 'holiday',
  'passover': 'holiday',
  'hanukkah': 'holiday',
}

function lookup(key: string): string | null {
  if (RANK.has(key)) return key
  return SYNONYMS[key] ?? null
}

/** One tag in its allowed form, or null if it isn't one we use. "Main Course"
 * → "mains", "Roman" → "italian", "Italian Recipes" → "italian", "beef" → null. */
export function normalizeTag(raw: string): string | null {
  const key = raw
    .toLowerCase()
    .trim()
    .replace(/[_\s]+/g, '-')
    .replace(/^-+|-+$/g, '')
  if (!key) return null
  return (
    lookup(key) ??
    // "Italian Recipes", "Mexican Food", "Thai Cuisine", "Soup Recipes"
    lookup(key.replace(/-(recipes?|food|cuisine|dishes)$/, '')) ??
    null
  )
}

/** Tags in their allowed form, de-duplicated, in display order. Imports cap
 * them (`max`) so a page's long keyword list can't tag a recipe with half the
 * list; the editor doesn't — what you pick, you keep. */
export function normalizeTags(raw: readonly unknown[] | null | undefined, max = Infinity): string[] {
  const out = new Set<string>()
  for (const item of raw ?? []) {
    if (typeof item !== 'string') continue
    const tag = normalizeTag(item)
    if (tag) out.add(tag)
  }
  return [...out].sort((a, b) => RANK.get(a)! - RANK.get(b)!).slice(0, max)
}

/** The tags that normalizeTags would drop — for the editor to say so. */
export function droppedTags(raw: readonly string[]): string[] {
  return raw.filter((t) => t.trim() && !normalizeTag(t))
}
