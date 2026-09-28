/**
 * Pure-logic tests for the fixed tag list (src/lib/tags.ts): what an import's
 * loose tags become, what's dropped, and the display order.
 *
 *   npm run test:tags
 */
import { ALL_TAGS, TAG_GROUPS, droppedTags, normalizeTag, normalizeTags } from '../src/lib/tags'

let passed = 0
let failed = 0
function eq(label: string, a: unknown, b: unknown): void {
  const ok = JSON.stringify(a) === JSON.stringify(b)
  if (ok) { console.log(`  ✓ ${label} (${JSON.stringify(a)})`); passed++ }
  else { console.error(`  ✗ ${label} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`); failed++ }
}

console.log('the list')
eq('no duplicates', ALL_TAGS.length, new Set(ALL_TAGS).size)
eq('all lowercase, hyphenated', ALL_TAGS.every((t) => /^[a-z]+(-[a-z]+)*$/.test(t)), true)
eq('groups in browse order', TAG_GROUPS.map((g) => g.key), ['course', 'cuisine', 'dish', 'diet', 'occasion'])

console.log('normalizeTag')
eq('allowed tag kept', normalizeTag('italian'), 'italian')
eq('case + spaces', normalizeTag('  Gluten Free '), 'gluten-free')
eq('course synonym', normalizeTag('Main Course'), 'mains')
eq('side dish', normalizeTag('side dish'), 'sides')
eq('region → cuisine', normalizeTag('roman'), 'italian')
eq('sichuan → chinese', normalizeTag('Sichuan'), 'chinese')
eq('"Italian Recipes"', normalizeTag('Italian Recipes'), 'italian')
eq('"Soup Recipes"', normalizeTag('Soup Recipes'), 'soup')
eq('"Mexican Food"', normalizeTag('Mexican Food'), 'mexican')
eq('pescetarian spelling', normalizeTag('pescetarian'), 'pescatarian')
eq('ramen → noodles', normalizeTag('ramen'), 'noodles')
eq('thanksgiving → holiday', normalizeTag('Thanksgiving'), 'holiday')
eq('ingredient dropped', normalizeTag('beef'), null)
eq('gadget dropped', normalizeTag('pressure cooker'), null)
eq('method dropped', normalizeTag('braise'), null)
eq('equipment dropped', normalizeTag('dutch-oven'), null)
eq('blank', normalizeTag('   '), null)

console.log('normalizeTags')
// The Serious Eats bolognese import's tags, roughly.
eq('bolognese import',
  normalizeTags(['italian', 'pasta', 'pressure cooker', 'beef', 'pork', 'main course', 'roman', 'Italian Recipes']),
  ['mains', 'italian', 'pasta'])
eq('display order: course → cuisine → dish → diet → occasion',
  normalizeTags(['weeknight', 'vegetarian', 'soup', 'thai', 'mains']),
  ['mains', 'thai', 'soup', 'vegetarian', 'weeknight'])
eq('non-strings ignored', normalizeTags(['vegan', 3, null, { tag: 'x' }]), ['vegan'])
eq('nothing → empty', normalizeTags(undefined), [])
eq('import cap', normalizeTags(['mains', 'sides', 'italian', 'french', 'pasta', 'soup', 'vegan', 'holiday'], 6).length, 6)
eq('no cap by default (editor)', normalizeTags(['mains', 'sides', 'italian', 'french', 'pasta', 'soup', 'vegan', 'holiday']).length, 8)

console.log('droppedTags')
eq('reports what the editor will drop', droppedTags(['main course', 'beef', 'roman', 'pressure cooker', '']), ['beef', 'pressure cooker'])

console.log(`\n${passed} passed, ${failed} failed`)
if (failed) process.exit(1)
