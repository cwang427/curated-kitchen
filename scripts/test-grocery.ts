/**
 * Unit test for grocery merge + aisle grouping.
 *   npx tsx scripts/test-grocery.ts
 */
import { additionFromIngredient, planMerge, groupByAisle, formatGroceryAmount, parseQuickAdd } from '../src/lib/grocery'
import type { Addition } from '../src/lib/grocery'
import type { GroceryItem, Ingredient } from '../src/lib/types'

let pass = 0
let fail = 0
function check(label: string, cond: boolean, detail?: string) {
  if (cond) pass++
  else {
    fail++
    console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`)
  }
}

const item = (p: Partial<GroceryItem>): GroceryItem => ({
  id: 'x', name: 'thing', canonical: 'thing', quantity: null, quantityMax: null,
  unit: null, category: 'other', checked: false, note: null, addedBy: null,
  createdAt: null, updatedAt: null, ...p,
})
const add = (p: Partial<Addition>): Addition => ({
  name: 'thing', canonical: 'thing', quantity: null, quantityMax: null,
  unit: null, category: 'other', note: null, ...p,
})

console.log('planMerge')
{
  // Count items merge: 2 onions + 1 onion → 3.
  const plan = planMerge(
    [item({ id: 'o1', canonical: 'onion', name: 'onion', quantity: 2, unit: null, category: 'produce' })],
    [add({ canonical: 'onion', name: 'onion', quantity: 1, category: 'produce' })],
  )
  check('no new item created', plan.creates.length === 0, `${plan.creates.length}`)
  check('existing bumped to 3', plan.updates[0]?.quantity === 3, JSON.stringify(plan.updates))
}
{
  // Compatible units convert: 1 cup stock + 240 ml → 2 cups.
  const plan = planMerge(
    [item({ id: 's1', canonical: 'stock', quantity: 1, unit: 'cup', category: 'pantry' })],
    [add({ canonical: "stock", quantity: 236.5882365, unit: "ml", category: "pantry" })],
  )
  check('ml folds into cups', Math.abs((plan.updates[0]?.quantity ?? 0) - 2) < 1e-6, JSON.stringify(plan.updates))
}
{
  // Incompatible dimensions do NOT merge: 2 oranges (count) vs 1/2 cup juice.
  const plan = planMerge(
    [item({ id: 'z', canonical: 'orange', quantity: 2, unit: null, category: 'produce' })],
    [add({ canonical: 'orange', quantity: 0.5, unit: 'cup', category: 'produce' })],
  )
  check('incompatible units create a new line', plan.creates.length === 1, JSON.stringify(plan))
}
{
  // Checked items are ignored — re-adding after shopping starts fresh.
  const plan = planMerge(
    [item({ id: 'c', canonical: 'onion', quantity: 2, checked: true, category: 'produce' })],
    [add({ canonical: 'onion', quantity: 1, category: 'produce' })],
  )
  check('checked item not merged into', plan.updates.length === 0 && plan.creates.length === 1, JSON.stringify(plan))
}
{
  // Two additions of the same thing in one batch merge together.
  const plan = planMerge(
    [],
    [add({ canonical: 'garlic', quantity: 2, unit: 'clove' }), add({ canonical: 'garlic', quantity: 3, unit: 'clove' })],
  )
  check('batch dedupes to one create', plan.creates.length === 1, JSON.stringify(plan.creates))
  check('batch sums to 5', plan.creates[0]?.quantity === 5, JSON.stringify(plan.creates))
}

console.log('additionFromIngredient (scaled)')
{
  const ing: Ingredient = {
    id: 'butter', quantity: 2, quantityMax: null, unit: 'tbsp', item: 'unsalted butter',
    itemPlural: null, canonical: 'butter', prep: null, alt: null, note: null,
    optional: false, scalable: true, category: 'dairy', group: null, raw: '',
  }
  const a = additionFromIngredient(ing, 2)
  check('scaled quantity', a.quantity === 4, `${a.quantity}`)
  check('carries canonical + category', a.canonical === 'butter' && a.category === 'dairy')
}

console.log('groupByAisle (store order)')
{
  const groups = groupByAisle([
    item({ id: '1', name: 'soy sauce', category: 'condiments' }),
    item({ id: '2', name: 'onion', category: 'produce' }),
    item({ id: '3', name: 'apple', category: 'produce' }),
    item({ id: '4', name: 'short ribs', category: 'meat' }),
  ])
  check('produce before meat before condiments', groups.map((g) => g.category).join(',') === 'produce,meat,condiments', groups.map((g) => g.category).join(','))
  check('alphabetized within aisle', groups[0].items.map((i) => i.name).join(',') === 'apple,onion', groups[0].items.map((i) => i.name).join(','))
  check('label is human', groups[2].label === 'Condiments & sauces', groups[2].label)
}

console.log('formatGroceryAmount')
{
  check('count', formatGroceryAmount(item({ quantity: 3, unit: null })) === '3')
  check('fraction + unit', formatGroceryAmount(item({ quantity: 1.5, unit: 'cup' })) === '1½ cups')
  check('none', formatGroceryAmount(item({ quantity: null })) === '')
}

console.log('parseQuickAdd')
{
  const lemons = parseQuickAdd('2 lemons')!
  check('parses count', lemons.quantity === 2 && lemons.unit === null, JSON.stringify(lemons))
  check('names the item', lemons.name === 'lemons', lemons.name)
  check('guesses produce', lemons.category === 'produce', lemons.category)

  const rice = parseQuickAdd('1 cup rice')!
  check('parses unit', rice.quantity === 1 && rice.unit === 'cup', JSON.stringify(rice))

  const milk = parseQuickAdd('2% milk')!
  check('odd leading token kept whole', milk.name === '2% milk' && milk.quantity === null, JSON.stringify(milk))
  check('still guesses dairy', milk.category === 'dairy', milk.category)

  const bare = parseQuickAdd('paper towels')!
  check('bare item, no amount', bare.quantity === null && bare.name === 'paper towels', JSON.stringify(bare))

  check('empty → null', parseQuickAdd('   ') === null)
}

console.log(`\n${pass} passed, ${fail} failed`)
if (fail > 0) process.exit(1)
