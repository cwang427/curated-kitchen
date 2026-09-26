/**
 * Pure-logic tests for unit + item pluralization (src/lib/units.ts), how an
 * ingredient line renders with it (formatIngredient), and how {{ }} step
 * amounts parse. Guards the "bay leafs" / "bay leaveses" and "1 /2 oz" bugs.
 *
 *   npm run test:units
 */
import { pluralizeWord, normalizeUnit, unitLabel } from '../src/lib/units'
import { formatIngredient, formatStepQuantity, parseAmountToken, parseStepText } from '../src/lib/quantity'
import type { Ingredient } from '../src/lib/types'

let passed = 0
let failed = 0
function eq(label: string, a: unknown, b: unknown): void {
  const ok = JSON.stringify(a) === JSON.stringify(b)
  if (ok) { console.log(`  ✓ ${label} (${JSON.stringify(a)})`); passed++ }
  else { console.error(`  ✗ ${label} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`); failed++ }
}

function ing(item: string, quantity: number | null, unit: string | null = null): Ingredient {
  return {
    id: 'x', quantity, quantityMax: null, unit, item, itemPlural: null, canonical: 'x',
    prep: null, alt: null, note: null, optional: false, scalable: true, category: 'other',
    group: null, raw: item,
  }
}

console.log('pluralizeWord')
eq('regular', pluralizeWord('egg'), 'eggs')
eq('-f → -ves', pluralizeWord('bay leaf'), 'bay leaves')
eq('-o → -oes', pluralizeWord('plum tomato'), 'plum tomatoes')
eq('-ch → -es', pluralizeWord('peach'), 'peaches')
eq('consonant-y → -ies', pluralizeWord('cherry'), 'cherries')
eq('vowel-y stays -s', pluralizeWord('turkey'), 'turkeys')
eq('already plural is left alone', pluralizeWord('bay leaves'), 'bay leaves')
eq('already plural (regular) is left alone', pluralizeWord('scallions'), 'scallions')
eq('-ss singular still pluralizes', pluralizeWord('watercress'), 'watercresses')
eq('invariant', pluralizeWord('shrimp'), 'shrimp')
eq('capitalization kept', pluralizeWord('Bay Leaf'), 'Bay Leaves')
eq('accented letters', pluralizeWord('jalapeño'), 'jalapeños')

console.log('\nunits')
eq('leaf unit plural', unitLabel('leaf', true), 'leaves')
eq('loaf unit plural', unitLabel('loaf', true), 'loaves')
eq('pinch unit plural', unitLabel('pinch', true), 'pinches')
eq('clove unit plural', unitLabel('clove', true), 'cloves')
eq('"leaves" is recognized', normalizeUnit('leaves'), 'leaf')
eq('"pinches" is recognized', normalizeUnit('pinches'), 'pinch')
eq('"boxes" is recognized', normalizeUnit('boxes'), 'box')
eq('"slices" still recognized', normalizeUnit('slices'), 'slice')
eq('"cups" still recognized', normalizeUnit('cups'), 'cup')

console.log('\nrendered ingredient lines')
eq('2 bay leaf → bay leaves', formatIngredient(ing('bay leaf', 2)).text, '2 bay leaves')
eq('1 bay leaf stays singular', formatIngredient(ing('bay leaf', 1)).text, '1 bay leaf')
eq('typed plural isn’t doubled', formatIngredient(ing('bay leaves', 2)).text, '2 bay leaves')
eq('scaled up', formatIngredient(ing('bay leaf', 1), 2).text, '2 bay leaves')
eq('"of" phrase pluralizes the head', formatIngredient(ing('sprig of thyme', 3)).text, '3 sprigs of thyme')
eq('leaf as a unit', formatIngredient(ing('basil', 4, 'leaf')).text, '4 leaves basil')

console.log('\n{{ }} step amounts')
const amt = (t: string) => {
  const a = parseAmountToken(t)
  return a && [a.quantity, a.quantityMax, a.unit]
}
eq('simple fraction', amt('1/2 oz'), [0.5, null, 'oz'])
eq('bare fraction', amt('3/4'), [0.75, null, null])
eq('mixed number', amt('1 1/2 cups'), [1.5, null, 'cup'])
eq('decimal', amt('1.5 cups'), [1.5, null, 'cup'])
eq('whole number', amt('16 oz'), [16, null, 'oz'])
eq('range', amt('2-3 cloves'), [2, 3, 'clove'])
eq('fraction range', amt('1/2-1 cup'), [0.5, 1, 'cup'])
const renderStep = (text: string, factor: number) =>
  parseStepText(text).map((s) => (s.type === 'text' ? s.value : formatStepQuantity(s, factor))).join('')
eq('"{{1/2 oz}}" renders as ½ oz', renderStep('Sprinkle {{1/2 oz}} gelatin', 1), 'Sprinkle ½ oz gelatin')
eq('…and scales', renderStep('Sprinkle {{1/2 oz}} gelatin', 2), 'Sprinkle 1 oz gelatin')

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed > 0 ? 1 : 0)
