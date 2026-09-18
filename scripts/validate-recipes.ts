import { loadRecipes } from './recipe-files'

const { loaded, errors } = await loadRecipes()

for (const { file, warnings, recipe } of loaded) {
  const status = warnings.length === 0 ? '✓' : '!'
  console.log(`${status} ${file} — ${recipe.title} (${recipe.ingredients.length} ingredients, ${recipe.steps.length} steps)`)
  for (const warning of warnings) console.log(`  · ${warning}`)
}

for (const { file, message } of errors) {
  console.error(`✗ ${file}`)
  console.error(message)
}

const warningCount = loaded.reduce((sum, r) => sum + r.warnings.length, 0)
console.log(
  `\n${loaded.length} valid, ${errors.length} invalid, ${warningCount} warning(s)`,
)

if (errors.length > 0) process.exit(1)
