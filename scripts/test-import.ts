/**
 * Unit test for the JSON-LD → authoring-format converter. The JSON-LD below is
 * synthetic — it exercises the parser's cases (ranges, metric asides, fractions,
 * HowToSection nesting, ISO durations, yield ranges, aisle guessing). Real page
 * data comes from the import workflow fetching the live URL.
 *
 *   npx tsx scripts/test-import.ts
 */
import { parseIngredientLine, parseDuration, recipeFromJsonLd } from '../src/lib/importRecipe'
import { parseRecipe } from '../src/lib/recipeSchema'

let pass = 0
let fail = 0
function check(label: string, cond: boolean, detail?: string) {
  if (cond) {
    pass++
  } else {
    fail++
    console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`)
  }
}

console.log('parseIngredientLine')
{
  const a = parseIngredientLine('2 tablespoons (30ml) vegetable oil')
  check('quantity', a.quantity === 2, `got ${a.quantity}`)
  check('unit normalized', a.unit === 'tbsp', `got ${a.unit}`)
  check('item', a.item === 'vegetable oil', `got "${a.item}"`)
  check('alt metric', a.alt?.quantity === 30 && a.alt?.unit === 'ml', JSON.stringify(a.alt))
  check('category pantry', a.category === 'pantry', a.category)

  const b = parseIngredientLine('4 pounds (1.8kg) bone-in beef short ribs')
  check('lb unit', b.unit === 'lb', b.unit ?? 'null')
  check('alt kg', b.alt?.unit === 'kg', JSON.stringify(b.alt))
  check('category meat', b.category === 'meat', b.category)

  const c = parseIngredientLine('6 cloves garlic, minced')
  check('clove unit', c.unit === 'clove', c.unit ?? 'null')
  check('prep', c.prep === 'minced', c.prep ?? 'null')
  check('category produce', c.category === 'produce', c.category)

  const d = parseIngredientLine('1/2 cup (120ml) honey')
  check('fraction', d.quantity === 0.5, `got ${d.quantity}`)
  check('honey condiment', d.category === 'condiments', d.category)

  const e = parseIngredientLine('2 to 3 dried chiles')
  check('range low', e.quantity === 2, `got ${e.quantity}`)
  check('range high', e.quantityMax === 3, `got ${e.quantityMax}`)

  const f = parseIngredientLine('Kosher salt and freshly ground black pepper')
  check('no quantity', f.quantity === null, `got ${f.quantity}`)
  check('salt spices', f.category === 'spices', f.category)

  const g = parseIngredientLine('2 oranges, zest and juice')
  check('countable no unit', g.quantity === 2 && g.unit === null, `${g.quantity}/${g.unit}`)
  check('orange produce', g.category === 'produce', g.category)
}

console.log('parseDuration')
check('PT30M', parseDuration('PT30M') === 30)
check('PT2H30M', parseDuration('PT2H30M') === 150)
check('PT1H', parseDuration('PT1H') === 60)
check('garbage → null', parseDuration('later') === null)

console.log('recipeFromJsonLd → validates against the schema')
{
  const jsonld = {
    '@context': 'https://schema.org',
    '@graph': [
      { '@type': 'WebPage', name: 'ignore me' },
      {
        '@type': ['Recipe', 'NewsArticle'],
        name: 'Braised Short Ribs Test',
        description: 'A rich braise.',
        author: { '@type': 'Person', name: 'Test Cook' },
        prepTime: 'PT20M',
        cookTime: 'PT2H30M',
        totalTime: 'PT2H50M',
        recipeYield: '4 to 6 servings',
        recipeCuisine: 'American',
        recipeCategory: 'Mains, Braises',
        keywords: 'short ribs, beef, braise',
        recipeIngredient: [
          '2 tablespoons (30ml) vegetable oil',
          '4 pounds (1.8kg) bone-in beef short ribs',
          '1 cup (240ml) low-sodium soy sauce',
          '1/2 cup (120ml) honey',
          '6 cloves garlic, minced',
          '2 oranges, zest and juice',
          'Kosher salt and freshly ground black pepper',
        ],
        recipeInstructions: [
          {
            '@type': 'HowToSection',
            itemListElement: [
              { '@type': 'HowToStep', text: 'Heat the oil and sear the ribs on all sides.' },
              { '@type': 'HowToStep', text: 'Add soy, honey, garlic, and orange; braise until tender.' },
            ],
          },
        ],
      },
    ],
  }

  const { recipe, warnings } = recipeFromJsonLd(jsonld, 'https://www.seriouseats.com/example')
  check('title', recipe.title === 'Braised Short Ribs Test')
  check('source name', (recipe.source as { name: string }).name === 'Serious Eats')
  check('author', (recipe.source as { author: string }).author === 'Test Cook')
  check('yield range', JSON.stringify(recipe.yield) === JSON.stringify({ amount: 4, amountMax: 6, unit: 'servings' }))
  check('7 ingredients', (recipe.ingredients as unknown[]).length === 7)
  check('2 steps (section flattened)', (recipe.steps as unknown[]).length === 2)
  check('cook time parsed', (recipe.times as { cookMin: number }).cookMin === 150)
  check('tags deduped', Array.isArray(recipe.tags) && (recipe.tags as string[]).includes('beef'))

  // The whole point: the draft must pass our own validator.
  try {
    const result = parseRecipe(recipe)
    check('parseRecipe accepts the draft', true)
    console.log(`    (${result.warnings.length} schema warnings, expected for an unreviewed import)`)
  } catch (error) {
    check('parseRecipe accepts the draft', false, (error as Error).message)
  }

  console.log(`    import produced ${warnings.length} review warnings`)
}

console.log(`\n${pass} passed, ${fail} failed`)
if (fail > 0) process.exit(1)
