/**
 * Pure-logic tests for the recipe editor's draft layer: quantity parsing and a
 * seed → draft → input → parseRecipe round-trip (what "edit then save" does).
 *
 *   npm run test:draft
 */
import { parseAmount, seedToDraft, draftToInput, blankDraft } from '../src/lib/recipeDraft'
import { parseRecipe } from '../src/lib/recipeSchema'
import cacio from '../recipes/cacio-e-pepe.json'

let passed = 0
let failed = 0
function check(label: string, cond: boolean): void {
  if (cond) { console.log(`  ✓ ${label}`); passed++ }
  else { console.error(`  ✗ ${label}`); failed++ }
}
function eq(label: string, a: unknown, b: unknown): void {
  check(`${label} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`, JSON.stringify(a) === JSON.stringify(b))
}

console.log('parseAmount')
eq('blank → null', parseAmount(''), null)
eq('integer', parseAmount('2'), 2)
eq('decimal', parseAmount('0.5'), 0.5)
eq('simple fraction', parseAmount('1/2'), 0.5)
eq('mixed number', parseAmount('1 1/2'), 1.5)
eq('garbage → null', parseAmount('abc'), null)

console.log('seed → draft → input → parseRecipe (edit-then-save round trip)')
const seed = parseRecipe(cacio).recipe
const draft = seedToDraft(seed)
eq('draft keeps every ingredient', draft.ingredients.length, seed.ingredients.length)
eq('draft keeps every step', draft.steps.length, seed.steps.length)
check('brief lines carried into the textarea', draft.steps[0].brief.includes('\n') || draft.steps[0].brief.length > 0)

const reparsed = parseRecipe({ ...draftToInput(draft), slug: 'cacio-e-pepe-edit' }).recipe
eq('title survives', reparsed.title, seed.title)
eq('ingredient count survives', reparsed.ingredients.length, seed.ingredients.length)
eq('first ingredient item survives', reparsed.ingredients[0].item, seed.ingredients[0].item)
eq('first ingredient quantity survives', reparsed.ingredients[0].quantity, seed.ingredients[0].quantity)
eq('first ingredient unit survives', reparsed.ingredients[0].unit, seed.ingredients[0].unit)
eq('step count survives', reparsed.steps.length, seed.steps.length)
eq('brief survives the round trip', reparsed.steps[0].brief, seed.steps[0].brief)
// The pepper step uses ingredients; the link must survive editing.
eq('step→ingredient links survive', reparsed.steps[0].ingredientIds, seed.steps[0].ingredientIds)

console.log('editing a field then saving')
const edited = seedToDraft(seed)
edited.ingredients[0].quantity = '1/4'
const afterEdit = parseRecipe({ ...draftToInput(edited), slug: 'cacio-edit2' }).recipe
eq('edited quantity (1/4) is applied', afterEdit.ingredients[0].quantity, 0.25)

console.log('deleting an ingredient drops its stale step link')
const del = seedToDraft(seed)
const removedId = del.ingredients[0].id
del.ingredients = del.ingredients.filter((i) => i.id !== removedId)
const afterDel = parseRecipe({ ...draftToInput(del), slug: 'cacio-edit3' }).recipe
check('removed ingredient is gone', !afterDel.ingredients.some((i) => i.id === removedId))
check('no step still references the removed ingredient', afterDel.steps.every((s) => !s.ingredientIds.includes(removedId)))

console.log('blank draft is a valid starting point (with a title + one ingredient/step)')
const b = blankDraft()
b.title = 'Test'
b.ingredients[0].item = 'salt'
b.ingredients[0].category = 'spices'
b.steps[0].text = 'Do the thing.'
const fromScratch = parseRecipe({ ...draftToInput(b), slug: 'from-scratch' }).recipe
eq('from-scratch title', fromScratch.title, 'Test')
eq('from-scratch has the ingredient', fromScratch.ingredients[0].item, 'salt')

console.log('step photos round-trip through the draft')
{
  // Images are photo-document ids now (not URLs); they ride through the draft
  // untouched, and a step with none normalizes to [].
  const d = seedToDraft(seed)
  d.steps[0].images = ['photo_abc123']
  const r = parseRecipe({ ...draftToInput(d), slug: 'cacio-img' }).recipe
  eq('step image survives', r.steps[0].images, ['photo_abc123'])
  eq('a step with no photos normalizes to []', r.steps[1].images, [])
}

console.log("\nhandsOff tag rides through the draft (editing mustn't drop it)")
{
  // The AI import's hands-off tag is passthrough on the draft, so an in-app edit
  // preserves it; an absent tag stays absent.
  const d = seedToDraft(seed)
  d.steps[0].handsOff = true
  const r = parseRecipe({ ...draftToInput(d), slug: 'cacio-hands' }).recipe
  eq('handsOff:true survives the round trip', r.steps[0].handsOff, true)
  eq('an untagged step stays untagged', r.steps[1].handsOff, undefined)
}

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed > 0 ? 1 : 0)
