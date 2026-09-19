import cacio from '../../recipes/cacio-e-pepe.json'
import { parseRecipe } from '../../src/lib/recipeSchema'
import type { RecipeSeed } from '../../src/lib/types'

export interface UrlImportResult {
  seed: RecipeSeed
  warnings: string[]
}

/** Preview: return a real parsed recipe after a short "reading" delay. */
export async function importRecipeFromUrl(): Promise<UrlImportResult> {
  await new Promise((r) => setTimeout(r, 400))
  const { recipe, warnings } = parseRecipe(cacio)
  return { seed: recipe, warnings }
}
