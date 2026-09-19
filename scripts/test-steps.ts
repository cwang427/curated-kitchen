/**
 * Pure-logic tests for splitStepText — the cook-mode sentence splitter that
 * turns a step paragraph into one-action-per-line bullets. No DOM.
 *
 *   npm run test:steps
 */
import { splitStepText } from '../src/lib/quantity'

let passed = 0
let failed = 0
function eq(label: string, actual: unknown, expected: unknown): void {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a === e) {
    console.log(`  ✓ ${label}`)
    passed++
  } else {
    console.error(`  ✗ ${label}\n     got  ${a}\n     want ${e}`)
    failed++
  }
}

console.log('splitStepText')

eq('a single sentence stays one line', splitStepText('Preheat the oven to 350°F.'), [
  'Preheat the oven to 350°F.',
])

eq(
  'splits a two-sentence step',
  splitStepText('Heat the oil until shimmering. Add the ribs in a single layer.'),
  ['Heat the oil until shimmering.', 'Add the ribs in a single layer.'],
)

// The mid-sentence "(180°C)" period-free parenthetical and the em-dash clause
// must not trigger a split.
eq('does not split on a parenthetical or em-dash', splitStepText('Preheat to 350°F (180°C) — or use a slow cooker.'), [
  'Preheat to 350°F (180°C) — or use a slow cooker.',
])

// A {{ }} token never contains a terminator, so it is never broken.
const tokenStep =
  'Transfer {{2-3 tbsp}} of the pasta water into the skillet. Stir in the butter.'
eq('keeps a {{ }} token intact across a split', splitStepText(tokenStep), [
  'Transfer {{2-3 tbsp}} of the pasta water into the skillet.',
  'Stir in the butter.',
])

// A decimal inside a sentence ("1.5") isn't a sentence boundary (no space after
// the period), so it stays on one line.
eq('a decimal is not a sentence boundary', splitStepText('Simmer for 1.5 hours until tender.'), [
  'Simmer for 1.5 hours until tender.',
])

eq('trims and drops empty fragments', splitStepText('Cook until done.   Serve hot.  '), [
  'Cook until done.',
  'Serve hot.',
])

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed > 0 ? 1 : 0)
