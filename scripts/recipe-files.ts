import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parseRecipe, type ParseResult } from '../src/lib/recipeSchema'

export const RECIPES_DIR = join(process.cwd(), 'recipes')

export interface LoadedRecipe extends ParseResult {
  file: string
}

export interface LoadReport {
  loaded: LoadedRecipe[]
  errors: Array<{ file: string; message: string }>
}

function describeError(error: unknown): string {
  if (error && typeof error === 'object' && 'issues' in error) {
    const issues = (error as { issues: Array<{ path: unknown[]; message: string }> }).issues
    return issues
      .map((issue) => `  · ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n')
  }
  return `  · ${error instanceof Error ? error.message : String(error)}`
}

export async function loadRecipes(): Promise<LoadReport> {
  const entries = (await readdir(RECIPES_DIR)).filter((name) => name.endsWith('.json')).sort()

  const loaded: LoadedRecipe[] = []
  const errors: Array<{ file: string; message: string }> = []
  const seenSlugs = new Map<string, string>()

  for (const file of entries) {
    const text = await readFile(join(RECIPES_DIR, file), 'utf8')
    try {
      const result = parseRecipe(JSON.parse(text))

      const previous = seenSlugs.get(result.recipe.slug)
      if (previous) {
        errors.push({
          file,
          message: `  · duplicate slug "${result.recipe.slug}" (also in ${previous})`,
        })
        continue
      }
      seenSlugs.set(result.recipe.slug, file)

      const expected = file.replace(/\.json$/, '')
      if (result.recipe.slug !== expected) {
        result.warnings.push(`slug "${result.recipe.slug}" does not match filename`)
      }

      loaded.push({ ...result, file })
    } catch (error) {
      errors.push({ file, message: describeError(error) })
    }
  }

  return { loaded, errors }
}
