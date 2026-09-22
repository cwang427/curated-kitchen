/**
 * Pure-logic tests for tidying an AI-extracted recipe before validation
 * (src/lib/aiRecipe.ts). The fixture mimics what Gemini returns for a quick
 * Apple Note: no servings, unicode fractions inside {{ }}, a half-filled timer
 * and temperature — each of which used to make parseRecipe reject the import.
 *
 *   npm run test:ai
 */
import { sanitizeAiRecipe, repairTokens, AiRecipeError } from '../src/lib/aiRecipe'
import { parseRecipe } from '../src/lib/recipeSchema'

let passed = 0
let failed = 0
function check(label: string, cond: boolean): void {
  if (cond) { console.log(`  ✓ ${label}`); passed++ }
  else { console.error(`  ✗ ${label}`); failed++ }
}
function eq(label: string, a: unknown, b: unknown): void {
  check(`${label} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`, JSON.stringify(a) === JSON.stringify(b))
}
function throws(fn: () => unknown): boolean {
  try { fn(); return false } catch { return true }
}

const pickledOnions = {
  title: 'Pickled red onions',
  source: { name: '', author: '', url: '' },
  times: { prepMin: 10, totalMin: -1 },
  ingredients: [
    { quantity: 1, item: 'red onion', prep: 'thinly sliced', category: 'produce', scalable: true },
    { quantity: 0.5, unit: 'cup', item: 'apple cider vinegar', category: 'pantry' },
    { quantity: 0.5, unit: 'cup', item: 'water', category: 'bogus-aisle' },
    { quantity: 1, quantityMax: 1, unit: 'tbsp', item: 'sugar', category: 'baking' },
    { quantity: 0, item: 'salt', category: 'spices', note: '' },
    { item: '', category: 'other' },
  ],
  steps: [
    { text: 'Thinly slice the onion and pack it into a jar.', brief: ['Slice onion', 'Pack into jar', ''] },
    {
      text: 'Heat {{½ cup}} vinegar, {{1½ cups}} water, and {{a pinch}} of salt until dissolved.',
      brief: ['Heat {{½ cup}} vinegar + water'],
      temperature: { mode: 'surface' },
      timers: [{ label: 'Heat', seconds: 0 }],
    },
    { text: 'Pour the hot brine over the onions.', uses: ['red_onion', 'ghost_ingredient'] },
    { text: 'Let cool, about 30 minutes.', timers: [{ label: 'Cool', seconds: 1799.6 }], handsOff: true },
    { brief: ['Refrigerate', 'Keeps 2 weeks'] },
    { text: '' },
  ],
  tags: ['', 'condiment'],
  equipment: ['jar', 'small saucepan'],
  notes: [],
}

console.log('the raw model answer fails validation as-is (the bug)')
check('parseRecipe rejects the unsanitized answer', throws(() => parseRecipe({ ...pickledOnions, slug: 'x' })))

console.log('\nsanitized, it validates')
const clean = sanitizeAiRecipe(pickledOnions)
const { recipe } = parseRecipe({ ...clean, slug: 'pickled-red-onions-abcde' })
eq('title kept', recipe.title, 'Pickled red onions')
eq('missing yield → 1 batch (not an invented serving count)', recipe.yield, { amount: 1, amountMax: null, unit: 'batch' })
eq('empty source fields dropped', recipe.source.name, null)
eq('negative time dropped, valid one kept', [recipe.times.prepMin, recipe.times.totalMin], [10, null])
eq('blank-item ingredient dropped', recipe.ingredients.length, 5)
eq('unknown aisle → other', recipe.ingredients[2].category, 'other')
eq('quantityMax ≤ quantity dropped', recipe.ingredients[3].quantityMax, null)
eq('zero quantity → unmeasured', recipe.ingredients[4].quantity, null)
eq('empty steps dropped, brief-only step kept', recipe.steps.length, 5)
eq('unicode fractions made scalable', recipe.steps[1].text,
  'Heat {{1/2 cup}} vinegar, {{1 1/2 cups}} water, and a pinch of salt until dissolved.')
eq('brief tokens repaired too', recipe.steps[1].brief, ['Heat {{1/2 cup}} vinegar + water'])
eq('blank brief line dropped', recipe.steps[0].brief, ['Slice onion', 'Pack into jar'])
eq('temperature without a value dropped', recipe.steps[1].temperature, null)
eq('zero-second timer dropped', recipe.steps[1].timers, [])
eq('fractional seconds rounded', recipe.steps[3].timers, [{ label: 'Cool', seconds: 1800 }])
eq('handsOff survives', recipe.steps[3].handsOff, true)
eq('unknown ingredient link dropped, real one kept', recipe.steps[2].ingredientIds, ['red_onion'])
eq('brief-only step gets full text', recipe.steps[4].text, 'Refrigerate. Keeps 2 weeks.')
eq('blank tag dropped', recipe.tags, ['condiment'])
eq('equipment kept', recipe.equipment, ['jar', 'small saucepan'])

console.log('\nyield handling')
eq('a stated yield is kept',
  sanitizeAiRecipe({ ...pickledOnions, yield: { amount: 4, amountMax: 6, unit: 'servings' } }).yield,
  { amount: 4, amountMax: 6, unit: 'servings' })
eq('a unit with no amount → 1 of that unit',
  sanitizeAiRecipe({ ...pickledOnions, yield: { unit: 'jar' } }).yield, { amount: 1, unit: 'jar' })
eq('"servings" with no amount → 1 batch',
  sanitizeAiRecipe({ ...pickledOnions, yield: { amount: 0, unit: 'servings' } }).yield, { amount: 1, unit: 'batch' })

console.log('\ntokens, groups, urls')
eq('a good token is untouched', repairTokens('Add {{2 tbsp}} butter'), 'Add {{2 tbsp}} butter')
eq('a range token survives', repairTokens('{{2-3 cloves}}'), '{{2-3 cloves}}')
{
  const grouped = sanitizeAiRecipe({
    ...pickledOnions,
    ingredients: [{ quantity: 1, item: 'onion', category: 'produce', group: 'Brine' }],
  })
  eq('an undeclared group gets declared', grouped.groups, ['Brine'])
  check('…and then validates', !throws(() => parseRecipe({ ...grouped, slug: 'g' })))
}
eq('a non-http url is dropped',
  (sanitizeAiRecipe({ ...pickledOnions, source: { url: 'notes://abc' } }).source as { url?: string }).url, undefined)

console.log('\nnothing to salvage → a plain-words error')
check('no ingredients or steps throws AiRecipeError',
  (() => { try { sanitizeAiRecipe({ title: 'x', ingredients: [], steps: [] }); return false } catch (e) { return e instanceof AiRecipeError } })())
check('non-object throws', throws(() => sanitizeAiRecipe(null)))

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed > 0 ? 1 : 0)
