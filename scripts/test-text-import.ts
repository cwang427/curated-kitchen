/**
 * Tests the free pasted-text importer against real, full-page copies from
 * Serious Eats (the fixtures under scripts/fixtures/text/). These capture the
 * two step shapes (numbered and paragraph) and the real noise — nav, headnotes,
 * bullets, photo credits, "image collage" captions, and label-on-its-own-line
 * times — so a regression in the heuristics shows up here.
 *
 *   npm run test:text
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { importRecipeFromText } from '../src/lib/importText'
import type { RecipeSeed } from '../src/lib/types'

const here = dirname(fileURLToPath(import.meta.url))
const load = (name: string) => readFileSync(join(here, 'fixtures', 'text', name), 'utf8')

let passed = 0
let failed = 0
function check(label: string, cond: boolean, detail?: unknown): void {
  if (cond) {
    console.log(`  ✓ ${label}`)
    passed++
  } else {
    console.error(`  ✗ ${label}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ''}`)
    failed++
  }
}

/** No step should contain a photo credit or caption fragment. */
const NOISE = [/serious eats/i, / \/ /, /photo collage/i, /image collage/i, /^collage\b/i, /sheet pans side by side/i, /has been depressurized/i, /is transferred to the pressure/i, /close up view/i, /dotdash/i, /^recipe tip$/i]
function stepsAreClean(seed: RecipeSeed): boolean {
  return seed.steps.every((s) => !NOISE.some((re) => re.test(s.text)))
}

interface Expect {
  title: string
  ingredients: number
  steps: number
  prepMin?: number | null
  cookMin?: number | null
  totalMin?: number | null
  yield: [number, number | null]
}

function run(file: string, exp: Expect): void {
  console.log(`\n${file}`)
  const { seed } = importRecipeFromText(load(file))
  check('title', seed.title === exp.title, seed.title)
  check('ingredient count', seed.ingredients.length === exp.ingredients, seed.ingredients.length)
  check('step count', seed.steps.length === exp.steps, seed.steps.map((s) => s.text.slice(0, 40)))
  check('steps free of credits/captions', stepsAreClean(seed))
  if (exp.cookMin !== undefined) check('cook time', seed.times.cookMin === exp.cookMin, seed.times.cookMin)
  if (exp.prepMin !== undefined) check('prep time', seed.times.prepMin === exp.prepMin, seed.times.prepMin)
  if (exp.totalMin !== undefined) check('total time', seed.times.totalMin === exp.totalMin, seed.times.totalMin)
  check('yield amount', seed.yield.amount === exp.yield[0], seed.yield.amount)
  check('yield max', (seed.yield.amountMax ?? null) === exp.yield[1], seed.yield.amountMax)
  check('yield unit is servings', seed.yield.unit === 'servings', seed.yield.unit)
  // Every ingredient keeps its original line and a usable item name.
  check('ingredients all have an item', seed.ingredients.every((i) => i.item.length > 0))
}

run('potatoes.txt', {
  title: 'The Best Crispy Roast Potatoes Ever',
  ingredients: 8,
  steps: 5,
  prepMin: 10,
  cookMin: 75,
  totalMin: 85,
  yield: [6, 8],
})

run('shakshuka.txt', {
  title: 'Shakshuka (North African–Style Poached Eggs in Spicy Tomato Sauce)',
  ingredients: 13,
  steps: 3,
  cookMin: 35,
  totalMin: 35,
  yield: [4, 6],
})

run('stuffing.txt', {
  title: 'Classic Sage and Sausage Stuffing (Dressing)',
  ingredients: 11,
  steps: 4,
  prepMin: 10,
  cookMin: 135,
  totalMin: 170,
  yield: [10, 14],
})

run('bolognese.txt', {
  title: 'Pressure Cooker Ragù Bolognese Recipe',
  ingredients: 23,
  steps: 6,
  cookMin: 150,
  totalMin: 150,
  yield: [8, 10],
})

run('allrecipes.txt', {
  title: "Chef John's Shakshuka",
  ingredients: 16,
  steps: 5,
  prepMin: 15,
  cookMin: 35,
  totalMin: 50,
  yield: [6, null],
})

// A blog-style page with no "Ingredients"/"Directions" headings must DECLINE
// cleanly (the AI fallback handles these), never mis-parse. Same for a stray
// "ingredients"/"directions" mention in prose.
console.log('\ndeclines gracefully when the spine is missing')
{
  const headerless = [
    'Pasta Salad with Roasted Tomatoes',
    'Serves 8',
    'Roasted tomatoes',
    '4 cups grape tomatoes',
    'Olive oil',
    'Salt',
    'Oregano dressing',
    '1 big clove garlic',
    '1 1/2 tablespoons dried oregano',
    'Assembly',
    '1 pound dried pasta',
    'Roast tomatoes: Heat oven to 300°F and bake for 90 minutes.',
    'Make dressing: Chop the garlic and whisk in the oil.',
    'Assemble salad: Toss everything together and finish with basil.',
  ].join('\n')
  let declined = false
  try {
    importRecipeFromText(headerless)
  } catch {
    declined = true
  }
  check('headerless blog text declines instead of mis-parsing', declined)

  const decoy = 'I love talking about ingredients and directions in my recipes.\nThe end.'
  let declinedDecoy = false
  try {
    importRecipeFromText(decoy)
  } catch {
    declinedDecoy = true
  }
  check('a stray mention of the words in prose declines', declinedDecoy)
}

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed > 0 ? 1 : 0)
