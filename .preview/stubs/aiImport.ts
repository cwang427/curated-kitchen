import cacio from '../../recipes/cacio-e-pepe.json'
import { parseRecipe } from '../../src/lib/recipeSchema'
import type { RecipeSeed } from '../../src/lib/types'

export interface AiImportResult {
  seed: RecipeSeed
  warnings: string[]
}
export type AiInput = { text: string } | { image: { data: string; mediaType: string } }

/** Preview: return a real parsed recipe after a short "reading" delay. */
export async function importRecipeViaAI(): Promise<AiImportResult> {
  await new Promise((r) => setTimeout(r, 400))
  const { recipe, warnings } = parseRecipe(cacio)
  return { seed: recipe, warnings }
}
