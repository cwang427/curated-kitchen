/**
 * Import a recipe from a URL by reading its schema.org/Recipe JSON-LD.
 *
 *   npx tsx scripts/import-url.ts <url> [--write]
 *
 * Runs in the import-recipe workflow, where the runner has open internet (this
 * dev sandbox does not). Prints the converted draft; --write also saves it to
 * recipes/<slug>.json. The draft is meant to be reviewed — ingredient aisles
 * are guessed and step timers/scaling tokens are not inferred.
 */
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { findRecipeNode, recipeFromJsonLd } from '../src/lib/importRecipe'

const url = process.argv[2]
const write = process.argv.includes('--write')

if (!url || !/^https?:\/\//.test(url)) {
  console.error('Usage: tsx scripts/import-url.ts <url> [--write]')
  process.exit(1)
}

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15'

function extractJsonLdBlocks(html: string): unknown[] {
  const blocks: unknown[] = []
  const re = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi
  let match: RegExpExecArray | null
  while ((match = re.exec(html)) !== null) {
    try {
      blocks.push(JSON.parse(match[1].trim()))
    } catch {
      // A malformed block isn't fatal — a page can carry several.
    }
  }
  return blocks
}

const response = await fetch(url, { headers: { 'user-agent': UA, accept: 'text/html' } })
if (!response.ok) {
  console.error(`Fetch failed: ${response.status} ${response.statusText}`)
  process.exit(1)
}
const html = await response.text()

const blocks = extractJsonLdBlocks(html)
if (blocks.length === 0) {
  console.error('No JSON-LD found on the page.')
  process.exit(1)
}

const recipeNode = blocks.map((b) => findRecipeNode(b)).find(Boolean)
if (!recipeNode) {
  console.error('Found JSON-LD, but none of it is a schema.org/Recipe.')
  process.exit(1)
}

const { recipe, warnings } = recipeFromJsonLd(recipeNode, url)

console.log('--- DRAFT RECIPE ---')
console.log(JSON.stringify(recipe, null, 2))
console.log('--- REVIEW BEFORE SYNCING ---')
for (const warning of warnings) console.log(`  ! ${warning}`)

if (write) {
  const slug = String(recipe.slug)
  const path = join(process.cwd(), 'recipes', `${slug}.json`)
  await writeFile(path, `${JSON.stringify(recipe, null, 2)}\n`)
  console.log(`\nWrote recipes/${slug}.json`)
}
